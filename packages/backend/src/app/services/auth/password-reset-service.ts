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
import {
    addressMatches,
    claimLocked,
    destroySessionsQuietly,
    invalidatePendingPhoneChallenges,
} from '#app/services/auth/account-claim-service.js'
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
import { withTransactionResult } from '#app/services/shared/transaction-result.js'
import {
    findUsableToken,
    issueTokenLocked,
    runTokenTransaction,
} from '#app/services/auth/one-time-token.js'
import {
    renderBrandedEmail,
    type RenderedEmail,
} from '#app/services/notifications/email-templates.js'
import {
    isChallengeExpired,
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
    conflict,
    internalMessage,
    notFound,
    type AppResult,
    appErrorMessage,
} from '#app/services/shared/errors.js'
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
        // Every failure below is caught on purpose (ADR 0004, point 4): an error status would
        // tell an address that gets this far apart from one that does not.
        try {
            const byIp = await consumeAuthThrottle(
                throttlePolicies.forgotPasswordIp,
                requestMeta.ipAddress,
            )
            const allowed =
                byIp.allowed &&
                (normalizedEmail === '' ||
                    (
                        await consumeAuthThrottle(
                            throttlePolicies.forgotPasswordEmail,
                            normalizedEmail,
                        )
                    ).allowed)
            if (!allowed) return Result.ok({ message: GENERIC_RESET_MESSAGE })
        } catch (err: unknown) {
            logger.warn({ err }, 'Forgot password throttle unavailable')
            return Result.ok({ message: GENERIC_RESET_MESSAGE })
        }
        let user: Awaited<ReturnType<typeof userRepository.findByEmail>> | undefined
        if (normalizedEmail !== '') {
            try {
                user = await userRepository.findByEmail(normalizedEmail)
            } catch (err: unknown) {
                logger.warn(
                    { err, emailMasked: maskEmailForLogs(normalizedEmail) },
                    'Failed to load user by email for password reset',
                )
                return Result.ok({ message: GENERIC_RESET_MESSAGE })
            }
        }

        if (user !== undefined) {
            void passwordResetService.sendPasswordResetEmailInBackground(user.id, 'manual request')
        }

        return Result.ok({ message: GENERIC_RESET_MESSAGE })
    },

    async sendPasswordResetEmail(userId: bigint): Promise<AppResult<{ message: string }>> {
        const NO_EMAIL = 'no_email'
        // feat-096: issued under the user lock; an account without an address gets no token.
        const issued = await issueTokenLocked(passwordResetRepository, {
            userId,
            ttlMs: PASSWORD_RESET_TTL_MS,
            // feat-097: the reset proves this address; it claims the account only while the
            // account still has it.
            extra: (user) => ({ targetEmail: user.email }),
            check: (user) =>
                user.email === null
                    ? Result.err(badRequest('No email address', NO_EMAIL))
                    : Result.ok(undefined),
        })
        if (Result.isError(issued)) {
            if ('reason' in issued.error && issued.error.reason === NO_EMAIL) {
                return Result.ok({ message: GENERIC_RESET_MESSAGE })
            }
            return Result.err(issued.error)
        }

        const { rawToken, user } = issued.value
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
            return Result.err(sendResult.error)
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
            badRequest('Too many verification attempts. Please try again later.'),
        )
        if (Result.isError(ipThrottle)) {
            return Result.err(ipThrottle.error)
        }

        const phoneThrottle = await enforceThrottle(
            throttlePolicies.smsSendPhone,
            normalizedPhone,
            badRequest('Too many verification attempts. Please try again later.'),
        )
        if (Result.isError(phoneThrottle)) {
            return Result.err(phoneThrottle.error)
        }

        // Caught on purpose, like the e-mail flow: the answer stays the generic one.
        const lookup = await userRepository.findByPhone(normalizedPhone).then(
            (found) => ({ ok: true as const, user: found }),
            (err: unknown) => ({ ok: false as const, err }),
        )
        if (!lookup.ok) {
            logger.warn(
                { err: lookup.err, phoneMasked: maskPhoneForLogs(normalizedPhone) },
                'Failed to load user by phone for password reset',
            )
            return Result.ok({ message: GENERIC_PHONE_RESET_MESSAGE })
        }

        const user = lookup.user
        const shouldSendSms = user?.email === null

        const pendingChallengeResult = await findPendingChallenge(normalizedPhone, RESET_PHONE_FLOW)
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
        const created = await openChallenge({
            phone: normalizedPhone,
            flow: RESET_PHONE_FLOW,
            codeHash: createBlindVerificationCodeHash(),
            metadata,
        })

        return Result.ok({
            message: GENERIC_PHONE_RESET_MESSAGE,
            challengeId: created.id,
            expiresAt: created.expiresAt.toISOString(),
            resendAvailableAt: created.resendAvailableAt.toISOString(),
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
            badRequest('Too many password reset attempts. Please try again later.'),
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

        const newPasswordHash = await hashPassword(password)

        // feat-096/097: lock the user, check the address, consume the token and set the
        // password with the rotated sessionToken (ADR 0002) in ONE transaction. On an
        // account whose address was never verified the reset is a claim: the mailbox owner
        // gets the account and everything set up before the address was proven goes away.
        // Of two concurrent requests with one link exactly one consumes it; a failure rolls
        // everything back, the link stays usable and the password stays as it was.
        const applied = await runTokenTransaction(passwordResetRepository, resetToken, {
            check: (user) =>
                resetToken.targetEmail !== null && addressMatches(user, resetToken.targetEmail)
                    ? Result.ok(undefined)
                    : Result.err(
                          conflict(
                              'The account email changed after this link was sent',
                              'email_changed',
                          ),
                      ),
            apply: async (user, tx) => {
                const outcome = await claimLocked(tx, user, { newPasswordHash })
                // A claim retired them already; a verified account's phone stays, its
                // pending challenges go, in the same commit.
                if (!outcome.claimed && user.phone !== null && user.phone !== '') {
                    await invalidatePendingPhoneChallenges(user.phone, tx)
                }
                return {
                    userId: user.id,
                    previousSessionToken: outcome.previousSessionToken,
                    claimed: outcome.claimed,
                }
            },
            invalidate: [passwordResetRepository],
        })
        if (applied.kind === 'user_missing') {
            return Result.err(notFound('User', 'User not found'))
        }
        if (applied.kind === 'rejected') {
            return Result.err(applied.error)
        }
        if (applied.kind === 'unusable') {
            return Result.err(
                applied.reason === 'expired'
                    ? badRequest('Password reset link has expired', 'expired_token')
                    : badRequest('Password reset link has already been used', 'used_token'),
            )
        }
        const user = applied.value

        // ADR 0002: the rotated sessionToken is the revocation. This only deletes records
        // that are already rejected, so a failure is logged and must not fail a reset that
        // has been committed.
        await destroySessionsQuietly(user.previousSessionToken, user.userId)

        userNotificationService.security(
            user.userId,
            user.claimed ? 'account_claimed' : 'password_reset',
        )
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
            badRequest('Too many verification attempts. Please try again later.'),
        )
        if (Result.isError(ipThrottle)) {
            return Result.err(ipThrottle.error)
        }

        // Intentional: phone reset completion is not bound to the current browser session.
        // Users may request the SMS on one device and complete the reset from another.
        const challenge = await smsAuthChallengeRepository.findById(challengeId)
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

        const codeResult = await verifySmsCode(challenge, code, {
            noLongerValid: 'Phone reset challenge is no longer valid',
        })
        if (Result.isError(codeResult)) {
            return Result.err(codeResult.error)
        }

        const challengeUserId = extractChallengeUserId(challenge.metadata)
        if (challengeUserId === null) {
            return Result.err(badRequest('Invalid verification code'))
        }

        // Hashed before the lock: the row stays locked only for the statements below.
        const newPasswordHash = await hashPassword(password)

        // feat-106: the user is locked first (feat-096) and the account re-checked on the locked
        // row; the challenge is confirmed, the phone challenges and reset links retired and the
        // password rotated in one transaction. A refusal or a failure on the way rolls all of it
        // back, the confirmation included, so the code can be used again within its budget. The
        // try spent by verifySmsCode above stays spent.
        const reset = await withTransactionResult(async (tx) => {
            const user = await userRepository.lockById(challengeUserId, tx)
            if (user?.email !== null || user.phone !== challenge.phone) {
                return Result.err(badRequest('Phone reset challenge is invalid'))
            }

            const confirmedResult = await confirmChallenge(
                challenge,
                { noLongerValid: 'Phone reset challenge is no longer valid' },
                tx,
            )
            if (Result.isError(confirmedResult)) {
                return Result.err(confirmedResult.error)
            }

            await invalidatePendingPhoneChallenges(challenge.phone, tx)
            await passwordResetRepository.invalidatePendingByUserId(user.id, tx)

            const updated = await userRepository.update(
                user.id,
                { password: newPasswordHash, sessionToken: nanoid() },
                tx,
            )
            if (updated === undefined) {
                return Result.err(internalMessage('Failed to update password'))
            }

            return Result.ok({ updatedUser: updated, previousSessionToken: user.sessionToken })
        })
        if (Result.isError(reset)) {
            return Result.err(reset.error)
        }
        const { updatedUser, previousSessionToken } = reset.value

        // ADR 0002: best-effort memory cleanup, see the email reset above.
        await destroySessionsQuietly(previousSessionToken, updatedUser.id)

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
