import appConfig from '#config/app.js'
import logger from '#logger'
import {
    emailLinkVerificationRepository,
    emailVerificationRepository,
    userRepository,
} from '#app/repositories/index.js'
import { emailService } from '#app/services/notifications/email-service.js'
import { Result } from 'better-result'
import {
    badRequest,
    conflict,
    notFound,
    type AppResult,
    appErrorMessage,
} from '#app/services/shared/errors.js'
import { isUniqueViolation } from '#app/repositories/db-errors.js'
import { enforceThrottle } from '#app/services/auth/enforce-throttle.js'
import { normalizeEmail } from '#app/services/auth/auth-normalize.js'
import {
    consumeTokenAndApply,
    findUsableToken,
    issueToken,
} from '#app/services/auth/one-time-token.js'
import {
    renderBrandedEmail,
    type RenderedEmail,
} from '#app/services/notifications/email-templates.js'
import { throttlePolicies } from '#config/throttle-policies.js'

const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000
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
        const user = await userRepository.findById(userId)
        if (user === undefined) {
            return Result.err(notFound('User', 'User not found'))
        }

        if (user.emailVerifiedAt !== null) {
            return Result.ok({ message: 'Email is already verified' })
        }

        const rawToken = await issueToken(emailVerificationRepository, {
            userId,
            ttlMs: EMAIL_VERIFICATION_TTL_MS,
        })

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
            return Result.err(sendResult.error)
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
            badRequest('Too many verification attempts. Please try again later.'),
        )
        if (Result.isError(throttle)) {
            return Result.err(throttle.error)
        }

        const normalizedToken = token.trim()
        if (normalizedToken === '') {
            return Result.err(badRequest('Verification token is required'))
        }

        const usedMessage = badRequest('Verification link has already been used')
        const expiredMessage = badRequest('Verification link has expired')

        const verificationResult = await findUsableToken(
            emailVerificationRepository,
            normalizedToken,
            {
                used: usedMessage,
                expired: expiredMessage,
            },
        )
        if (Result.isError(verificationResult)) {
            return Result.err(verificationResult.error)
        }

        const verification = verificationResult.value
        if (verification === undefined) {
            const linkVerificationResult = await findUsableToken(
                emailLinkVerificationRepository,
                normalizedToken,
                {
                    used: usedMessage,
                    expired: expiredMessage,
                },
            )
            if (Result.isError(linkVerificationResult)) {
                return Result.err(linkVerificationResult.error)
            }

            const linkVerification = linkVerificationResult.value
            if (linkVerification === undefined) {
                return Result.err(badRequest('Verification link is invalid'))
            }

            const user = await userRepository.findById(linkVerification.userId)
            if (user === undefined) {
                return Result.err(notFound('User', 'User not found'))
            }

            const conflictingUser = await userRepository.findByEmail(
                normalizeEmail(linkVerification.targetEmail),
            )

            if (conflictingUser !== undefined && conflictingUser.id !== user.id) {
                return Result.err(conflict('Email is already linked to another account'))
            }

            // feat-060: claim the token and link the email in ONE transaction; a failure
            // rolls both back (the link stays usable).
            let applied: Awaited<ReturnType<typeof consumeTokenAndApply>>
            try {
                applied = await consumeTokenAndApply(
                    emailLinkVerificationRepository,
                    linkVerification,
                    async (tx) => {
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
                    },
                )
            } catch (err: unknown) {
                // Another account took the address between the check above and the update:
                // the unique index answers, and that is a business outcome, not a failure.
                if (isUniqueViolation(err)) {
                    return Result.err(conflict('Email is already linked to another account'))
                }
                throw err
            }
            if (!applied.claimed) {
                return Result.err(usedMessage)
            }

            return Result.ok({ message: 'Email linked successfully' })
        }

        const user = await userRepository.findById(verification.userId)
        if (user === undefined) {
            return Result.err(notFound('User', 'User not found'))
        }

        // feat-060: claim the token and confirm the email in ONE transaction (see the link
        // branch above).
        const applied = await consumeTokenAndApply(
            emailVerificationRepository,
            verification,
            async (tx) => {
                if (user.emailVerifiedAt === null) {
                    const updated = await userRepository.update(
                        user.id,
                        { emailVerifiedAt: new Date() },
                        tx,
                    )
                    if (updated === undefined)
                        throw new Error('User disappeared during verification')
                }
            },
        )
        if (!applied.claimed) {
            return Result.err(usedMessage)
        }

        return Result.ok({ message: 'Email confirmed successfully' })
    },

    async queueVerificationEmail(userId: bigint): Promise<AppResult<{ message: string }>> {
        const throttle = await enforceThrottle(
            throttlePolicies.resendVerificationUser,
            String(userId),
            badRequest('Too many verification emails requested. Please try again later.'),
        )
        if (Result.isError(throttle)) {
            return Result.err(throttle.error)
        }

        const user = await userRepository.findById(userId)
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
        const user = await userRepository.findById(userId)
        if (user === undefined) {
            return Result.err(notFound('User', 'User not found'))
        }

        const rawToken = await issueToken(emailLinkVerificationRepository, {
            userId,
            ttlMs: EMAIL_VERIFICATION_TTL_MS,
            extra: { targetEmail },
        })

        const verificationUrl = buildVerificationUrl(rawToken)
        const emailContent = buildLinkEmailContent(user.name, verificationUrl)
        const sendResult = await emailService.send({
            to: targetEmail,
            subject: emailContent.subject,
            text: emailContent.text,
            html: emailContent.html,
        })

        if (Result.isError(sendResult)) {
            return Result.err(sendResult.error)
        }

        return Result.ok({
            message: 'Verification email will be sent shortly',
        })
    },
}
