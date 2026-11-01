import { randomBytes } from 'node:crypto'
import { hashPassword } from 'metautil'
import { nanoid } from 'nanoid'
import appConfig from '#config/app.js'
import logger from '#logger'
import {
    smsAuthChallengeRepository,
    passwordResetRepository,
    userRepository,
} from '#app/repositories/index.js'
import { emailService } from '#app/services/notifications/email-service.js'
import { consumeAuthThrottle } from '#app/services/auth/auth-throttle-service.js'
import { enforceThrottle } from '#app/services/auth/enforce-throttle.js'
import {
    confirmChallenge,
    findPendingChallenge,
    issueSmsChallenge,
    openChallenge,
    verifySmsCode,
} from '#app/services/auth/sms-challenge.js'
import {
    consumeTokenAndApply,
    findUsableToken,
    issueToken,
} from '#app/services/auth/one-time-token.js'
import {
    renderBrandedEmail,
    type RenderedEmail,
} from '#app/services/notifications/email-templates.js'
import {
    isChallengeExpired,
    LINK_PHONE_FLOW,
    normalizeEmail,
    normalizePhone,
    RESET_PHONE_FLOW,
} from '#app/services/auth/auth-normalize.js'
import { throttlePolicies } from '#config/throttle-policies.js'
import { authConfig } from '#config/auth.js'
import {
    extractChallengeSessionId,
    extractChallengeUserId,
} from '#app/services/auth/sms-auth-challenge-metadata.js'
import { hashOtpVerificationCode } from '#app/services/auth/otp-verification-hash.js'
import { Result } from 'better-result'
import {
    badRequest,
    internal,
    internalMessage,
    notFound,
    type AppResult,
    appErrorMessage,
} from '#app/services/shared/errors.js'
import { tryInternal } from '#app/services/shared/result-helpers.js'
import { destroyAllSessions } from '#vendor/utils/session/redis-session-storage.js'
import { maskEmailForLogs, maskPhoneForLogs } from '#vendor/utils/helpers/mask-sensitive.js'
import { userNotificationService } from '#app/services/notifications/user-notification-service.js'

const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000
export const GENERIC_RESET_MESSAGE =
    'If an account with that email exists, a reset link will be sent shortly.'
export const GENERIC_PHONE_RESET_MESSAGE =
    'If the phone number can be used for password reset, verification instructions will be sent shortly.'
function buildResetUrl(token: string): string {
    return `${appConfig.frontendUrl}/reset-password?token=${encodeURIComponent(token)}`
}

function createBlindVerificationCodeHash(): string {
    return hashOtpVerificationCode(randomBytes(32).toString('hex'))
}

async function invalidatePendingPhoneChallenges(phone: string): Promise<void> {
    await Promise.all([
        smsAuthChallengeRepository.invalidatePendingForPhoneFlow(phone, RESET_PHONE_FLOW),
        smsAuthChallengeRepository.invalidatePendingForPhoneFlow(phone, LINK_PHONE_FLOW),
    ])
}

function buildResetEmailContent(name: string, resetUrl: string): RenderedEmail {
    return renderBrandedEmail({
        subject: 'Reset your password',
        preheader: 'Reset your Vibe Template password.',
        eyebrow: 'Password reset',
        title: 'Choose a new password',
        name,
        intro: 'We received a request to reset your Vibe Template password. Use the button below to set a new one.',
        action: { kind: 'button', label: 'Reset password', url: resetUrl },
        footer: 'This link will expire in 1 hour. If you did not request a password reset, you can safely ignore this email.',
        textLines: [
            'We received a request to reset your password.',
            'Open this link to choose a new password:',
            resetUrl,
            '',
            'This link will expire in 1 hour.',
            'If you did not request a password reset, you can safely ignore this email.',
        ],
    })
}

export const passwordResetService = {
    async requestPasswordReset(
        email: string,
        requestMeta: { ipAddress: string },
    ): Promise<AppResult<{ message: string }>> {
        const normalizedEmail = normalizeEmail(email)

        // Before the lookup, and the same generic answer either way: the response
        // never tells whether the address exists or whether the budget is spent.
        const throttles = await tryInternal(async () => {
            const byIp = await consumeAuthThrottle(
                throttlePolicies.forgotPasswordIp,
                requestMeta.ipAddress,
            )
            if (!byIp.allowed || normalizedEmail === '') return byIp
            return consumeAuthThrottle(throttlePolicies.forgotPasswordEmail, normalizedEmail)
        }, 'Failed to enforce forgot password throttle')
        if (Result.isError(throttles) || !throttles.value.allowed) {
            if (Result.isError(throttles)) {
                logger.warn({ err: throttles.error }, 'Forgot password throttle unavailable')
            }
            return Result.ok({ message: GENERIC_RESET_MESSAGE })
        }
        let user: Awaited<ReturnType<typeof userRepository.findByEmail>> | undefined
        if (normalizedEmail !== '') {
            const userResult = await tryInternal(
                () => userRepository.findByEmail(normalizedEmail),
                'Failed to load user by email',
            )
            if (Result.isError(userResult)) {
                logger.warn(
                    {
                        err: userResult.error,
                        emailMasked: maskEmailForLogs(normalizedEmail),
                    },
                    'Failed to load user by email for password reset',
                )
                return Result.ok({ message: GENERIC_RESET_MESSAGE })
            }
            user = userResult.value
        }

        if (user !== undefined) {
            void passwordResetService.sendPasswordResetEmailInBackground(user.id, 'manual request')
        }

        return Result.ok({ message: GENERIC_RESET_MESSAGE })
    },

    async sendPasswordResetEmail(userId: bigint): Promise<AppResult<{ message: string }>> {
        const userResult = await tryInternal(
            () => userRepository.findById(userId),
            'Failed to load user',
        )
        if (Result.isError(userResult)) {
            return Result.err(userResult.error)
        }

        const user = userResult.value
        if (user === undefined) {
            return Result.err(notFound('User', 'User not found'))
        }

        const issued = await issueToken(passwordResetRepository, {
            userId,
            ttlMs: PASSWORD_RESET_TTL_MS,
            failures: {
                invalidate: 'Failed to invalidate password reset tokens',
                create: 'Failed to create password reset token',
            },
        })
        if (Result.isError(issued)) {
            return Result.err(issued.error)
        }
        const rawToken = issued.value

        if (user.email === null) {
            return Result.ok({ message: GENERIC_RESET_MESSAGE })
        }

        const resetUrl = buildResetUrl(rawToken)
        const emailContent = buildResetEmailContent(user.name, resetUrl)
        const sendResult = await emailService.send({
            to: user.email,
            subject: emailContent.subject,
            text: emailContent.text,
            html: emailContent.html,
        })

        if (Result.isError(sendResult)) {
            return Result.err(internal(sendResult.error, 'Failed to send password reset email'))
        }

        return Result.ok({ message: 'Password reset email sent' })
    },

    async startPhonePasswordReset(
        phone: string,
        defaultCountry: string | undefined,
        requestMeta: { ipAddress: string; sessionId: string | null },
    ): Promise<
        AppResult<{
            message: string
            challengeId?: string
            expiresAt?: string
            resendAvailableAt?: string
        }>
    > {
        if (!authConfig.phoneAuthEnabled) {
            return Result.err(badRequest('Phone authentication is disabled'))
        }

        const normalizedPhoneResult = normalizePhone(phone, defaultCountry)
        if (Result.isError(normalizedPhoneResult)) {
            return Result.err(normalizedPhoneResult.error)
        }

        const normalizedPhone = normalizedPhoneResult.value

        const ipThrottle = await enforceThrottle(
            throttlePolicies.resetPhoneIp,
            requestMeta.ipAddress,
            {
                unavailable: 'Failed to enforce phone reset IP throttle',
                rejected: badRequest('Too many verification attempts. Please try again later.'),
            },
        )
        if (Result.isError(ipThrottle)) {
            return Result.err(ipThrottle.error)
        }

        const phoneThrottle = await enforceThrottle(
            throttlePolicies.smsSendPhone,
            normalizedPhone,
            {
                unavailable: 'Failed to enforce phone reset identifier throttle',
                rejected: badRequest('Too many verification attempts. Please try again later.'),
            },
        )
        if (Result.isError(phoneThrottle)) {
            return Result.err(phoneThrottle.error)
        }

        const userResult = await tryInternal(
            () => userRepository.findByPhone(normalizedPhone),
            'Failed to load user by phone',
        )
        if (Result.isError(userResult)) {
            logger.warn(
                {
                    err: userResult.error,
                    phoneMasked: maskPhoneForLogs(normalizedPhone),
                },
                'Failed to load user by phone for password reset',
            )
            return Result.ok({ message: GENERIC_PHONE_RESET_MESSAGE })
        }

        const user = userResult.value
        const shouldSendSms = user?.email === null

        const pendingChallengeResult = await findPendingChallenge(
            normalizedPhone,
            RESET_PHONE_FLOW,
            'Failed to load pending phone reset challenge',
        )
        if (Result.isError(pendingChallengeResult)) {
            return Result.err(pendingChallengeResult.error)
        }

        if (
            pendingChallengeResult.value !== undefined &&
            pendingChallengeResult.value.expiresAt.getTime() > Date.now()
        ) {
            const pendingChallengeSessionId = extractChallengeSessionId(
                pendingChallengeResult.value.metadata,
            )

            if (
                pendingChallengeSessionId !== null &&
                requestMeta.sessionId !== null &&
                pendingChallengeSessionId === requestMeta.sessionId
            ) {
                return Result.ok({
                    message: GENERIC_PHONE_RESET_MESSAGE,
                    challengeId: pendingChallengeResult.value.id,
                    expiresAt: pendingChallengeResult.value.expiresAt.toISOString(),
                    resendAvailableAt: pendingChallengeResult.value.resendAvailableAt.toISOString(),
                })
            }

            return Result.ok({
                message: GENERIC_PHONE_RESET_MESSAGE,
            })
        }

        const metadata = {
            ...(shouldSendSms ? { userId: String(user.id) } : { blind: true }),
            ipAddress: requestMeta.ipAddress,
            provider: authConfig.smsProvider,
            ...(requestMeta.sessionId !== null ? { sessionId: requestMeta.sessionId } : {}),
        }

        if (shouldSendSms) {
            const issuedResult = await issueSmsChallenge({
                phone: normalizedPhone,
                flow: RESET_PHONE_FLOW,
                metadata,
                failures: {
                    create: 'Failed to persist phone reset challenge',
                    issue: 'Failed to issue SMS verification code',
                    markIssued: 'Failed to persist issued phone reset challenge',
                },
                noLongerValid: 'Phone reset challenge is no longer valid',
            })
            if (Result.isError(issuedResult)) {
                return Result.err(issuedResult.error)
            }

            return Result.ok({
                message: GENERIC_PHONE_RESET_MESSAGE,
                challengeId: issuedResult.value.id,
                expiresAt: issuedResult.value.expiresAt.toISOString(),
                resendAvailableAt: issuedResult.value.resendAvailableAt.toISOString(),
            })
        }

        // Nothing to send: the number is unknown or the account has an e-mail. The challenge is
        // stored all the same, with a code hash nobody can match, so the answer looks the same.
        const createdResult = await openChallenge({
            phone: normalizedPhone,
            flow: RESET_PHONE_FLOW,
            codeHash: createBlindVerificationCodeHash(),
            metadata,
            failure: 'Failed to persist phone reset challenge',
        })
        if (Result.isError(createdResult)) {
            return Result.err(createdResult.error)
        }

        return Result.ok({
            message: GENERIC_PHONE_RESET_MESSAGE,
            challengeId: createdResult.value.id,
            expiresAt: createdResult.value.expiresAt.toISOString(),
            resendAvailableAt: createdResult.value.resendAvailableAt.toISOString(),
        })
    },

    async resetPassword(
        token: string,
        password: string,
        passwordConfirm: string,
        requestMeta: { ipAddress: string },
    ): Promise<AppResult<{ status: 'success' }>> {
        const throttle = await enforceThrottle(
            throttlePolicies.resetPasswordIp,
            requestMeta.ipAddress,
            {
                unavailable: 'Failed to enforce reset password throttle',
                rejected: badRequest('Too many password reset attempts. Please try again later.'),
            },
        )
        if (Result.isError(throttle)) {
            return Result.err(throttle.error)
        }

        const normalizedToken = token.trim()
        if (normalizedToken === '') {
            return Result.err(badRequest('Password reset token is required', 'token_required'))
        }

        if (password !== passwordConfirm) {
            return Result.err(badRequest('Passwords do not match', 'passwords_mismatch'))
        }

        const found = await findUsableToken(passwordResetRepository, normalizedToken, {
            failures: {
                load: 'Failed to load password reset token',
                markExpired: 'Failed to mark password reset token used',
            },
            used: badRequest('Password reset link has already been used', 'used_token'),
            expired: badRequest('Password reset link has expired', 'expired_token'),
        })
        if (Result.isError(found)) {
            return Result.err(found.error)
        }

        const resetToken = found.value
        if (resetToken === undefined) {
            return Result.err(badRequest('Password reset link is invalid', 'invalid_token'))
        }

        const userResult = await tryInternal(
            () => userRepository.findById(resetToken.userId),
            'Failed to load user',
        )
        if (Result.isError(userResult)) {
            return Result.err(userResult.error)
        }

        const user = userResult.value
        if (user === undefined) {
            return Result.err(notFound('User', 'User not found'))
        }
        const newPasswordHashResult = await tryInternal(
            () => hashPassword(password),
            'Failed to hash password',
        )
        if (Result.isError(newPasswordHashResult)) {
            return Result.err(newPasswordHashResult.error)
        }

        const newPasswordHash = newPasswordHashResult.value
        const previousSessionToken = user.sessionToken

        const userPhone = user.phone
        if (userPhone !== null && userPhone !== '') {
            const invalidatePhoneChallengesResult = await tryInternal(
                () => invalidatePendingPhoneChallenges(userPhone),
                'Failed to invalidate pending phone challenges after email password reset',
            )
            if (Result.isError(invalidatePhoneChallengesResult)) {
                return Result.err(invalidatePhoneChallengesResult.error)
            }
        }

        // feat-060: the token is claimed and its effect applied in ONE transaction. The
        // claim is `UPDATE ... SET used_at WHERE used_at IS NULL`, so of two concurrent
        // requests with one link exactly one gets the row; a failure after it rolls both
        // back, the link stays usable and the password stays as it was. The rotated
        // sessionToken (ADR 0002) is part of the same commit.
        const appliedResult = await consumeTokenAndApply(
            passwordResetRepository,
            resetToken,
            async (tx) => {
                const updated = await userRepository.update(
                    user.id,
                    { password: newPasswordHash, sessionToken: nanoid() },
                    tx,
                )
                if (updated === undefined) throw new Error('User disappeared during reset')
                return updated
            },
            'Failed to update password',
        )
        if (Result.isError(appliedResult)) {
            return Result.err(appliedResult.error)
        }
        if (!appliedResult.value.claimed) {
            return Result.err(badRequest('Password reset link has already been used', 'used_token'))
        }

        // ADR 0002: the rotated sessionToken is the revocation. This only deletes records
        // that are already rejected, so a failure is logged and must not fail a reset that
        // has been committed.
        const destroySessionsResult = await tryInternal(
            () => destroyAllSessions(previousSessionToken),
            'Failed to destroy sessions',
        )
        if (Result.isError(destroySessionsResult)) {
            logger.warn(
                { err: destroySessionsResult.error, userId: String(user.id) },
                'Previous sessions not deleted after a password reset',
            )
        }

        userNotificationService.security(user.id, 'password_reset')
        return Result.ok({ status: 'success' })
    },

    async completePhonePasswordReset(
        challengeId: string,
        code: string,
        password: string,
        passwordConfirm: string,
        requestMeta: { ipAddress: string },
    ): Promise<AppResult<{ status: 'success' }>> {
        if (!authConfig.phoneAuthEnabled) {
            return Result.err(badRequest('Phone authentication is disabled'))
        }

        if (password !== passwordConfirm) {
            return Result.err(badRequest('Passwords do not match', 'passwords_mismatch'))
        }

        const ipThrottle = await enforceThrottle(
            throttlePolicies.confirmResetPhoneIp,
            requestMeta.ipAddress,
            {
                unavailable: 'Failed to enforce phone reset confirmation IP throttle',
                rejected: badRequest('Too many verification attempts. Please try again later.'),
            },
        )
        if (Result.isError(ipThrottle)) {
            return Result.err(ipThrottle.error)
        }

        // Intentional: phone reset completion is not bound to the current browser session.
        // Users may request the SMS on one device and complete the reset from another.
        const challengeResult = await tryInternal(
            () => smsAuthChallengeRepository.findById(challengeId),
            'Failed to load SMS auth challenge',
        )
        if (Result.isError(challengeResult)) {
            return Result.err(challengeResult.error)
        }

        const challenge = challengeResult.value
        if (challenge?.flow !== RESET_PHONE_FLOW) {
            return Result.err(badRequest('Phone reset challenge is invalid'))
        }

        if (
            challenge.invalidatedAt !== null ||
            challenge.confirmedAt !== null ||
            isChallengeExpired(challenge.expiresAt)
        ) {
            return Result.err(badRequest('Phone reset challenge is no longer valid'))
        }

        const codeResult = await verifySmsCode(challenge, code)
        if (Result.isError(codeResult)) {
            return Result.err(codeResult.error)
        }

        const challengeUserId = extractChallengeUserId(challenge.metadata)
        if (challengeUserId === null) {
            return Result.err(badRequest('Invalid verification code'))
        }

        const userResult = await tryInternal(
            () => userRepository.findById(challengeUserId),
            'Failed to load user for phone reset',
        )
        if (Result.isError(userResult)) {
            return Result.err(userResult.error)
        }

        const user = userResult.value
        if (user?.email !== null || user.phone !== challenge.phone) {
            return Result.err(badRequest('Phone reset challenge is invalid'))
        }

        const confirmedResult = await confirmChallenge(challenge, {
            failure: 'Failed to mark phone reset challenge confirmed',
            noLongerValid: 'Phone reset challenge is no longer valid',
        })
        if (Result.isError(confirmedResult)) {
            return Result.err(confirmedResult.error)
        }

        const newPasswordHashResult = await tryInternal(
            () => hashPassword(password),
            'Failed to hash password',
        )
        if (Result.isError(newPasswordHashResult)) {
            return Result.err(newPasswordHashResult.error)
        }

        const previousSessionToken = user.sessionToken

        const invalidatePhoneChallengesResult = await tryInternal(
            () => invalidatePendingPhoneChallenges(challenge.phone),
            'Failed to invalidate pending phone challenges after phone password reset',
        )
        if (Result.isError(invalidatePhoneChallengesResult)) {
            return Result.err(invalidatePhoneChallengesResult.error)
        }

        const updatedUserResult = await tryInternal(
            () =>
                userRepository.update(user.id, {
                    password: newPasswordHashResult.value,
                    sessionToken: nanoid(),
                }),
            'Failed to update password',
        )
        if (Result.isError(updatedUserResult)) {
            return Result.err(updatedUserResult.error)
        }

        const updatedUser = updatedUserResult.value
        if (updatedUser === undefined) {
            return Result.err(internalMessage('Failed to update password'))
        }

        // ADR 0002: best-effort memory cleanup, see the email reset above.
        const destroySessionsResult = await tryInternal(
            () => destroyAllSessions(previousSessionToken),
            'Failed to destroy sessions',
        )
        if (Result.isError(destroySessionsResult)) {
            logger.warn(
                { err: destroySessionsResult.error, userId: String(updatedUser.id) },
                'Previous sessions not deleted after a password reset',
            )
        }

        userNotificationService.security(updatedUser.id, 'password_reset')
        return Result.ok({ status: 'success' })
    },

    async sendPasswordResetEmailInBackground(
        userId: bigint,
        reason: 'manual request',
    ): Promise<void> {
        try {
            const result = await this.sendPasswordResetEmail(userId)
            if (Result.isError(result)) {
                logger.warn(
                    {
                        userId: String(userId),
                        reason: appErrorMessage(result.error),
                        trigger: reason,
                    },
                    'Failed to send password reset email in background',
                )
            }
        } catch (err) {
            logger.error(
                { err, userId: String(userId), trigger: reason },
                'Unexpected error while sending password reset email in background',
            )
        }
    },
}
