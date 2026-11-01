import { createHash, randomBytes } from 'node:crypto'
import { hashPassword } from 'metautil'
import { nanoid } from 'nanoid'
import appConfig from '#config/app.js'
import logger from '#logger'
import { PENDING_SMS_CODE_HASH_PLACEHOLDER } from './sms-auth-challenge-constants.js'
import {
    smsAuthChallengeRepository,
    passwordResetRepository,
    userRepository,
    withTransaction,
} from '#app/repositories/index.js'
import { emailService } from '#app/services/notifications/email-service.js'
import { consumeAuthThrottle } from '#app/services/auth/auth-throttle-service.js'
import { enforceThrottle } from '#app/services/auth/enforce-throttle.js'
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
import { smsVerificationProvider } from '#app/services/auth/sms-verification-provider.js'
import {
    buildResendCooldownError,
    extractChallengeSessionId,
    extractChallengeUserId,
} from '#app/services/auth/sms-auth-challenge-metadata.js'
import {
    hashOtpVerificationCode,
    verifyOtpVerificationCode,
} from '#app/services/auth/otp-verification-hash.js'
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
function hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex')
}

function createResetToken(): string {
    return randomBytes(32).toString('base64url')
}

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

        const invalidateResult = await tryInternal(
            () => passwordResetRepository.invalidatePendingByUserId(userId),
            'Failed to invalidate password reset tokens',
        )
        if (Result.isError(invalidateResult)) {
            return Result.err(invalidateResult.error)
        }

        const rawToken = createResetToken()
        const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MS)
        const createResult = await tryInternal(
            () =>
                passwordResetRepository.create({
                    userId,
                    tokenHash: hashToken(rawToken),
                    expiresAt,
                }),
            'Failed to create password reset token',
        )
        if (Result.isError(createResult)) {
            return Result.err(createResult.error)
        }

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

        const pendingChallengeResult = await tryInternal(
            () =>
                smsAuthChallengeRepository.findLatestPendingForPhoneFlow(
                    normalizedPhone,
                    RESET_PHONE_FLOW,
                ),
            'Failed to load pending phone reset challenge',
        )
        if (Result.isError(pendingChallengeResult)) {
            return Result.err(pendingChallengeResult.error)
        }
        if (
            pendingChallengeResult.value !== undefined &&
            pendingChallengeResult.value.resendAvailableAt.getTime() > Date.now()
        ) {
            return Result.err(
                buildResendCooldownError(pendingChallengeResult.value.resendAvailableAt),
            )
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

        await smsAuthChallengeRepository.invalidatePendingForPhoneFlow(
            normalizedPhone,
            RESET_PHONE_FLOW,
        )

        const now = Date.now()
        const expiresAt = new Date(now + authConfig.smsChallengeTtlSeconds * 1000)
        const resendAvailableAt = new Date(now + authConfig.smsResendCooldownSeconds * 1000)

        const createdResult = await tryInternal(
            () =>
                smsAuthChallengeRepository.create({
                    flow: RESET_PHONE_FLOW,
                    phone: normalizedPhone,
                    codeHash: shouldSendSms
                        ? PENDING_SMS_CODE_HASH_PLACEHOLDER
                        : createBlindVerificationCodeHash(),
                    providerRequestId: null,
                    expiresAt,
                    resendAvailableAt,
                    metadata: {
                        ...(shouldSendSms ? { userId: String(user.id) } : { blind: true }),
                        ipAddress: requestMeta.ipAddress,
                        provider: authConfig.smsProvider,
                        ...(requestMeta.sessionId !== null
                            ? { sessionId: requestMeta.sessionId }
                            : {}),
                    },
                }),
            'Failed to persist phone reset challenge',
        )
        if (Result.isError(createdResult)) {
            return Result.err(createdResult.error)
        }

        if (shouldSendSms) {
            const issueCodeResult = await tryInternal(
                () =>
                    smsVerificationProvider.issueVerificationCode({
                        phone: normalizedPhone,
                        flow: RESET_PHONE_FLOW,
                    }),
                'Failed to issue SMS verification code',
            )
            if (Result.isError(issueCodeResult)) {
                await smsAuthChallengeRepository.markInvalidated(createdResult.value.id)
                return Result.err(issueCodeResult.error)
            }

            const issuedResult = await tryInternal(
                () =>
                    smsAuthChallengeRepository.markIssued(createdResult.value.id, {
                        codeHash: hashOtpVerificationCode(issueCodeResult.value.code),
                        providerRequestId: issueCodeResult.value.providerRequestId,
                        metadata: {
                            userId: String(user.id),
                            ipAddress: requestMeta.ipAddress,
                            provider: authConfig.smsProvider,
                            ...(requestMeta.sessionId !== null
                                ? { sessionId: requestMeta.sessionId }
                                : {}),
                        },
                    }),
                'Failed to persist issued phone reset challenge',
            )
            if (Result.isError(issuedResult)) {
                await smsAuthChallengeRepository.markInvalidated(createdResult.value.id)
                return Result.err(issuedResult.error)
            }
            if (issuedResult.value === undefined) {
                await smsAuthChallengeRepository.markInvalidated(createdResult.value.id)
                return Result.err(badRequest('Phone reset challenge is no longer valid'))
            }

            return Result.ok({
                message: GENERIC_PHONE_RESET_MESSAGE,
                challengeId: issuedResult.value.id,
                expiresAt: issuedResult.value.expiresAt.toISOString(),
                resendAvailableAt: issuedResult.value.resendAvailableAt.toISOString(),
            })
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

        const resetTokenResult = await tryInternal(
            () => passwordResetRepository.findByTokenHash(hashToken(normalizedToken)),
            'Failed to load password reset token',
        )
        if (Result.isError(resetTokenResult)) {
            return Result.err(resetTokenResult.error)
        }

        const resetToken = resetTokenResult.value
        if (resetToken === undefined) {
            return Result.err(badRequest('Password reset link is invalid', 'invalid_token'))
        }

        if (resetToken.usedAt !== null) {
            return Result.err(badRequest('Password reset link has already been used', 'used_token'))
        }

        if (resetToken.expiresAt.getTime() < Date.now()) {
            const markExpiredResult = await tryInternal(
                () => passwordResetRepository.markUsed(resetToken.id),
                'Failed to mark password reset token used',
            )
            if (Result.isError(markExpiredResult)) {
                return Result.err(markExpiredResult.error)
            }

            return Result.err(badRequest('Password reset link has expired', 'expired_token'))
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
        const appliedResult = await tryInternal(
            () =>
                withTransaction(async (tx) => {
                    const claimed = await passwordResetRepository.markUsed(
                        resetToken.id,
                        undefined,
                        tx,
                    )
                    if (claimed === undefined) return { claimed: false as const }

                    const updated = await userRepository.update(
                        user.id,
                        { password: newPasswordHash, sessionToken: nanoid() },
                        tx,
                    )
                    if (updated === undefined) throw new Error('User disappeared during reset')
                    return { claimed: true as const, user: updated }
                }),
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

        if (!verifyOtpVerificationCode(code, challenge.codeHash)) {
            const updatedChallenge = await smsAuthChallengeRepository.incrementAttemptCount(
                challenge.id,
            )
            if (
                (updatedChallenge?.attemptCount ?? challenge.attemptCount + 1) >=
                authConfig.smsMaxInvalidAttempts
            ) {
                await smsAuthChallengeRepository.markInvalidated(challenge.id)
            }

            return Result.err(badRequest('Invalid verification code'))
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

        const confirmedResult = await tryInternal(
            () => smsAuthChallengeRepository.markConfirmed(challenge.id),
            'Failed to mark phone reset challenge confirmed',
        )
        if (Result.isError(confirmedResult)) {
            return Result.err(confirmedResult.error)
        }
        if (confirmedResult.value === undefined) {
            return Result.err(badRequest('Phone reset challenge is no longer valid'))
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
