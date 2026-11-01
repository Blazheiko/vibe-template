import { createHash, randomBytes } from 'node:crypto'
import appConfig from '#config/app.js'
import logger from '#logger'
import {
    emailLinkVerificationRepository,
    emailVerificationRepository,
    userRepository,
    withTransaction,
} from '#app/repositories/index.js'
import { emailService } from '#app/services/notifications/email-service.js'
import { Result } from 'better-result'
import {
    badRequest,
    conflict,
    internal,
    notFound,
    type AppResult,
    appErrorMessage,
} from '#app/services/shared/errors.js'
import { tryInternal } from '#app/services/shared/result-helpers.js'
import { enforceThrottle } from '#app/services/auth/enforce-throttle.js'
import { normalizeEmail } from '#app/services/auth/auth-normalize.js'
import {
    renderBrandedEmail,
    type RenderedEmail,
} from '#app/services/notifications/email-templates.js'
import { throttlePolicies } from '#config/throttle-policies.js'

const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000
function hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex')
}

function createVerificationToken(): string {
    return randomBytes(32).toString('base64url')
}

function buildVerificationUrl(token: string): string {
    const baseUrl = appConfig.frontendUrl
    return `${baseUrl}/verify-email?token=${encodeURIComponent(token)}`
}

function buildLinkEmailContent(name: string, verificationUrl: string): RenderedEmail {
    return renderBrandedEmail({
        subject: 'Confirm your new email',
        eyebrow: 'Email linking',
        title: 'Confirm your new email address',
        name,
        intro: 'Confirm this email to finish linking it to your Vibe Template account.',
        action: { kind: 'link', url: verificationUrl },
        footer: 'This link will expire in 24 hours. If you did not request this change, you can safely ignore this email.',
        textLines: [
            'Please confirm this new email address for your Vibe Template account by opening this link:',
            verificationUrl,
            '',
            'This link will expire in 24 hours.',
        ],
    })
}

function buildEmailContent(name: string, verificationUrl: string): RenderedEmail {
    return renderBrandedEmail({
        subject: 'Confirm your email',
        preheader: 'Confirm your Vibe Template email address.',
        eyebrow: 'Email verification',
        title: 'Confirm your email address',
        name,
        intro: 'Finish setting up your Vibe Template account by confirming this email address. The button below will take you straight back into the app.',
        action: { kind: 'button', label: 'Confirm email', url: verificationUrl },
        footer: 'This link will expire in 24 hours. If you did not create an account, you can safely ignore this email.',
        textLines: [
            'Please confirm your email address by opening this link:',
            verificationUrl,
            '',
            'This link will expire in 24 hours.',
        ],
    })
}

export const emailVerificationService = {
    async sendVerificationEmail(userId: bigint): Promise<AppResult<{ message: string }>> {
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

        if (user.emailVerifiedAt !== null) {
            return Result.ok({ message: 'Email is already verified' })
        }

        const invalidateResult = await tryInternal(
            () => emailVerificationRepository.invalidatePendingByUserId(userId),
            'Failed to invalidate email verification tokens',
        )
        if (Result.isError(invalidateResult)) {
            return Result.err(invalidateResult.error)
        }

        const rawToken = createVerificationToken()
        const expiresAt = new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS)
        const createResult = await tryInternal(
            () =>
                emailVerificationRepository.create({
                    userId,
                    tokenHash: hashToken(rawToken),
                    expiresAt,
                }),
            'Failed to create email verification token',
        )
        if (Result.isError(createResult)) {
            return Result.err(createResult.error)
        }

        if (user.email === null) {
            return Result.err(badRequest('Email verification requires an email address'))
        }

        const verificationUrl = buildVerificationUrl(rawToken)
        const emailContent = buildEmailContent(user.name, verificationUrl)
        const sendResult = await emailService.send({
            to: user.email,
            subject: emailContent.subject,
            text: emailContent.text,
            html: emailContent.html,
        })

        if (Result.isError(sendResult)) {
            return Result.err(internal(sendResult.error, 'Failed to send verification email'))
        }

        return Result.ok({ message: 'Verification email sent' })
    },

    async verifyEmail(
        token: string,
        requestMeta: { ipAddress: string },
    ): Promise<AppResult<{ message: string }>> {
        const throttle = await enforceThrottle(
            throttlePolicies.verifyEmailIp,
            requestMeta.ipAddress,
            {
                unavailable: 'Failed to enforce email verification throttle',
                rejected: badRequest('Too many verification attempts. Please try again later.'),
            },
        )
        if (Result.isError(throttle)) {
            return Result.err(throttle.error)
        }

        const normalizedToken = token.trim()
        if (normalizedToken === '') {
            return Result.err(badRequest('Verification token is required'))
        }

        const verificationResult = await tryInternal(
            () => emailVerificationRepository.findByTokenHash(hashToken(normalizedToken)),
            'Failed to load email verification token',
        )
        if (Result.isError(verificationResult)) {
            return Result.err(verificationResult.error)
        }

        const verification = verificationResult.value
        if (verification === undefined) {
            const linkVerificationResult = await tryInternal(
                () => emailLinkVerificationRepository.findByTokenHash(hashToken(normalizedToken)),
                'Failed to load email link token',
            )
            if (Result.isError(linkVerificationResult)) {
                return Result.err(linkVerificationResult.error)
            }

            const linkVerification = linkVerificationResult.value
            if (linkVerification === undefined) {
                return Result.err(badRequest('Verification link is invalid'))
            }

            if (linkVerification.usedAt !== null) {
                return Result.err(badRequest('Verification link has already been used'))
            }

            if (linkVerification.expiresAt.getTime() < Date.now()) {
                const markExpiredResult = await tryInternal(
                    () => emailLinkVerificationRepository.markUsed(linkVerification.id),
                    'Failed to mark email link token used',
                )
                if (Result.isError(markExpiredResult)) {
                    return Result.err(markExpiredResult.error)
                }

                return Result.err(badRequest('Verification link has expired'))
            }

            const userResult = await tryInternal(
                () => userRepository.findById(linkVerification.userId),
                'Failed to load user',
            )
            if (Result.isError(userResult)) {
                return Result.err(userResult.error)
            }

            const user = userResult.value
            if (user === undefined) {
                return Result.err(notFound('User', 'User not found'))
            }

            const conflictingUserResult = await tryInternal(
                () => userRepository.findByEmail(normalizeEmail(linkVerification.targetEmail)),
                'Failed to load user by email',
            )
            if (Result.isError(conflictingUserResult)) {
                return Result.err(conflictingUserResult.error)
            }

            if (
                conflictingUserResult.value !== undefined &&
                conflictingUserResult.value.id !== user.id
            ) {
                return Result.err(conflict('Email is already linked to another account'))
            }

            // feat-060: claim the token and link the email in ONE transaction. The claim is
            // `UPDATE ... SET used_at WHERE used_at IS NULL`: of two concurrent requests with
            // one link exactly one gets the row, and a failure rolls both back (the link
            // stays usable).
            const appliedResult = await tryInternal(
                () =>
                    withTransaction(async (tx) => {
                        const claimed = await emailLinkVerificationRepository.markUsed(
                            linkVerification.id,
                            undefined,
                            tx,
                        )
                        if (claimed === undefined) return { claimed: false as const }

                        const updated = await userRepository.update(
                            user.id,
                            {
                                email: normalizeEmail(linkVerification.targetEmail),
                                emailVerifiedAt: new Date(),
                            },
                            tx,
                        )
                        if (updated === undefined)
                            throw new Error('User disappeared during linking')
                        return { claimed: true as const }
                    }),
                'Failed to link email',
            )
            if (Result.isError(appliedResult)) {
                if (
                    appliedResult.error._tag === 'Internal' &&
                    appliedResult.error.cause !== null &&
                    typeof appliedResult.error.cause === 'object' &&
                    'code' in appliedResult.error.cause &&
                    appliedResult.error.cause.code === '23505'
                ) {
                    return Result.err(conflict('Email is already linked to another account'))
                }
                return Result.err(appliedResult.error)
            }
            if (!appliedResult.value.claimed) {
                return Result.err(badRequest('Verification link has already been used'))
            }

            return Result.ok({ message: 'Email linked successfully' })
        }

        if (verification.usedAt !== null) {
            return Result.err(badRequest('Verification link has already been used'))
        }

        if (verification.expiresAt.getTime() < Date.now()) {
            const markExpiredResult = await tryInternal(
                () => emailVerificationRepository.markUsed(verification.id),
                'Failed to mark email verification token used',
            )
            if (Result.isError(markExpiredResult)) {
                return Result.err(markExpiredResult.error)
            }

            return Result.err(badRequest('Verification link has expired'))
        }

        const userResult = await tryInternal(
            () => userRepository.findById(verification.userId),
            'Failed to load user',
        )
        if (Result.isError(userResult)) {
            return Result.err(userResult.error)
        }

        const user = userResult.value
        if (user === undefined) {
            return Result.err(notFound('User', 'User not found'))
        }

        // feat-060: claim the token and confirm the email in ONE transaction (see the link
        // branch above).
        const appliedResult = await tryInternal(
            () =>
                withTransaction(async (tx) => {
                    const claimed = await emailVerificationRepository.markUsed(
                        verification.id,
                        undefined,
                        tx,
                    )
                    if (claimed === undefined) return { claimed: false as const }

                    if (user.emailVerifiedAt === null) {
                        const updated = await userRepository.update(
                            user.id,
                            { emailVerifiedAt: new Date() },
                            tx,
                        )
                        if (updated === undefined)
                            throw new Error('User disappeared during verification')
                    }
                    return { claimed: true as const }
                }),
            'Failed to verify email',
        )
        if (Result.isError(appliedResult)) {
            return Result.err(appliedResult.error)
        }
        if (!appliedResult.value.claimed) {
            return Result.err(badRequest('Verification link has already been used'))
        }

        return Result.ok({ message: 'Email confirmed successfully' })
    },

    async queueVerificationEmail(userId: bigint): Promise<AppResult<{ message: string }>> {
        const throttle = await enforceThrottle(
            throttlePolicies.resendVerificationUser,
            String(userId),
            {
                unavailable: 'Failed to enforce verification email throttle',
                rejected: badRequest(
                    'Too many verification emails requested. Please try again later.',
                ),
            },
        )
        if (Result.isError(throttle)) {
            return Result.err(throttle.error)
        }

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

        if (user.emailVerifiedAt !== null) {
            return Result.ok({ message: 'Email is already verified' })
        }

        void this.sendVerificationEmailInBackground(userId, 'manual resend')
        return Result.ok({ message: 'Verification email will be sent shortly' })
    },

    async sendVerificationEmailInBackground(
        userId: bigint,
        reason: 'registration' | 'manual resend' | 'unverified login',
    ): Promise<void> {
        try {
            const result = await this.sendVerificationEmail(userId)
            if (Result.isError(result)) {
                logger.warn(
                    {
                        userId: String(userId),
                        reason: appErrorMessage(result.error),
                        trigger: reason,
                    },
                    'Failed to send verification email in background',
                )
            }
        } catch (err) {
            logger.error(
                { err, userId: String(userId), trigger: reason },
                'Unexpected error while sending verification email in background',
            )
        }
    },

    async sendVerificationEmailAfterRegistration(userId: bigint): Promise<void> {
        await this.sendVerificationEmailInBackground(userId, 'registration')
    },

    async sendLinkVerificationEmail(
        userId: bigint,
        targetEmail: string,
    ): Promise<AppResult<{ message: string }>> {
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
            () => emailLinkVerificationRepository.invalidatePendingByUserId(userId),
            'Failed to invalidate email link tokens',
        )
        if (Result.isError(invalidateResult)) {
            return Result.err(invalidateResult.error)
        }

        const rawToken = createVerificationToken()
        const expiresAt = new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS)
        const createResult = await tryInternal(
            () =>
                emailLinkVerificationRepository.create({
                    userId,
                    targetEmail,
                    tokenHash: hashToken(rawToken),
                    expiresAt,
                }),
            'Failed to create email link token',
        )
        if (Result.isError(createResult)) {
            return Result.err(createResult.error)
        }

        const verificationUrl = buildVerificationUrl(rawToken)
        const emailContent = buildLinkEmailContent(user.name, verificationUrl)
        const sendResult = await emailService.send({
            to: targetEmail,
            subject: emailContent.subject,
            text: emailContent.text,
            html: emailContent.html,
        })

        if (Result.isError(sendResult)) {
            return Result.err(internal(sendResult.error, 'Failed to send email link verification'))
        }

        return Result.ok({
            message: 'Verification email will be sent shortly',
        })
    },
}
