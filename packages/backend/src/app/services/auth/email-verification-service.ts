import appConfig from '#config/app.js'
import logger from '#logger'
import {
    emailLinkVerificationRepository,
    emailVerificationRepository,
    userRepository,
} from '#app/repositories/index.js'
import { emailService } from '#app/services/notifications/email-service.js'
import { Result } from 'better-result'
import { validatePassword } from 'metautil'
import {
    type AppError,
    appErrorMessage,
    type AppResult,
    badRequest,
    conflict,
    forbidden,
    notFound,
    rateLimited,
    sessionRevoked,
} from '#app/services/shared/errors.js'
import { isUniqueViolation } from '#app/repositories/db-errors.js'
import { enforceThrottle } from '#app/services/auth/enforce-throttle.js'
import { normalizeEmail } from '#app/services/auth/auth-normalize.js'
import {
    findUsableToken,
    issueTokenLocked,
    runTokenTransaction,
    type TokenTransactionOutcome,
} from '#app/services/auth/one-time-token.js'
import {
    renderBrandedEmail,
    type RenderedEmail,
} from '#app/services/notifications/email-templates.js'
import { throttlePolicies } from '#config/throttle-policies.js'
import { safeEqual } from '#vendor/utils/helpers/safe-equal.js'

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
        intro: 'Confirm this email to finish linking it to your Vibe Template account. Open the link in the browser where you are signed in to that account.',
        action: { kind: 'link', url: verificationUrl },
        footer: 'This link will expire in 24 hours. If you did not request this, ignore this email: the link does nothing unless you are signed in to the account that asked for it.',
        textLines: [
            'Please confirm this new email address for your Vibe Template account by opening this link',
            'in the browser where you are signed in to that account:',
            verificationUrl,
            '',
            'This link will expire in 24 hours.',
            'If you did not request this, ignore this email.',
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
        intro: 'Finish setting up your Vibe Template account by confirming this email address. You will be asked for the password you chose when you signed up.',
        action: { kind: 'button', label: 'Confirm email', url: verificationUrl },
        footer: 'This link will expire in 24 hours. If you did not create an account, ignore this email: without the account password the link confirms nothing.',
        textLines: [
            'Please confirm your email address by opening this link',
            'and entering the password you chose when you signed up:',
            verificationUrl,
            '',
            'This link will expire in 24 hours.',
            'If you did not create an account, ignore this email.',
        ],
    })
}

export const EMAIL_LINK_WRONG_SESSION = 'email_link_wrong_session'
export const VERIFY_PASSWORD_REQUIRED = 'password_required'
export const VERIFY_PASSWORD_INVALID = 'invalid_password'

/** The registration link's owner check by password (feat-097). */
async function checkOwnerPassword(
    owner: { id: bigint; password: string | null },
    password: string | undefined,
): Promise<AppResult<void>> {
    if (password === undefined || password === '') {
        return Result.err(
            forbidden(
                'Enter the password of this account to confirm the email',
                VERIFY_PASSWORD_REQUIRED,
            ),
        )
    }
    const throttle = await enforceThrottle(
        throttlePolicies.verifyEmailPasswordUser,
        String(owner.id),
        rateLimited('Too many verification attempts. Please try again later.'),
    )
    if (Result.isError(throttle)) return Result.err(throttle.error)

    const stored = owner.password
    const valid = stored !== null && stored !== '' && (await validatePassword(password, stored))
    return valid
        ? Result.ok(undefined)
        : Result.err(badRequest('Password is incorrect', VERIFY_PASSWORD_INVALID))
}

/** The answer for a token transaction that did not apply, or undefined when it did. */
function tokenOutcomeError(
    outcome: TokenTransactionOutcome<unknown>,
    used: AppError,
    expired: AppError,
): AppError | undefined {
    switch (outcome.kind) {
        case 'applied':
            return undefined
        case 'unusable':
            return outcome.reason === 'expired' ? expired : used
        case 'rejected':
            return outcome.error
        case 'user_missing':
            return notFound('User', 'User not found')
    }
}

export const emailVerificationService = {
    async sendVerificationEmail(userId: bigint): Promise<AppResult<{ message: string }>> {
        const ALREADY_VERIFIED = 'already_verified'
        const issued = await issueTokenLocked(emailVerificationRepository, {
            userId,
            ttlMs: EMAIL_VERIFICATION_TTL_MS,
            // Checked on the locked row: a verification or a change of address that
            // committed meanwhile is seen here, not after a token was issued for it.
            check: (user) => {
                if (user.emailVerifiedAt !== null) {
                    return Result.err(badRequest('Email is already verified', ALREADY_VERIFIED))
                }
                if (user.email === null) {
                    return Result.err(badRequest('Email verification requires an email address'))
                }
                return Result.ok(undefined)
            },
        })
        if (Result.isError(issued)) {
            if ('reason' in issued.error && issued.error.reason === ALREADY_VERIFIED) {
                return Result.ok({ message: 'Email is already verified' })
            }
            return Result.err(issued.error)
        }

        const { rawToken, user } = issued.value
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

    /**
     * `requester` is who opens the link (feat-097). A registration link confirms the account
     * only from a session of that account or with its password, and an email link only from
     * a session of the account that asked for it: a link mailed to somebody who did not ask
     * for it does nothing when clicked.
     */
    async verifyEmail(
        token: string,
        requestMeta: { ipAddress: string },
        requester: {
            userId: bigint | null
            presentedSessionToken: string | undefined
            password?: string
        },
    ): Promise<AppResult<{ message: string }>> {
        const throttle = await enforceThrottle(
            throttlePolicies.verifyEmailIp,
            requestMeta.ipAddress,
            rateLimited('Too many verification attempts. Please try again later.'),
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

            if (requester.userId !== linkVerification.userId) {
                return Result.err(
                    forbidden(
                        'Open this link while signed in to the account that asked for it',
                        EMAIL_LINK_WRONG_SESSION,
                    ),
                )
            }

            const targetEmail = normalizeEmail(linkVerification.targetEmail)
            const conflictingUser = await userRepository.findByEmail(targetEmail)
            if (conflictingUser !== undefined && conflictingUser.id !== linkVerification.userId) {
                return Result.err(conflict('Email is already linked to another account'))
            }

            // feat-096: lock the user, check the row, consume the token and link the
            // address in ONE transaction; a failure rolls all of it back (the link stays
            // usable).
            let linked: TokenTransactionOutcome<void>
            try {
                linked = await runTokenTransaction(
                    emailLinkVerificationRepository,
                    linkVerification,
                    {
                        // The link adds an address to an account that has none; one linked
                        // meanwhile (another link, a change) is not overwritten.
                        check: (user) => {
                            // The session that opened the link must still be current.
                            const presented = requester.presentedSessionToken
                            if (
                                presented === undefined ||
                                !safeEqual(user.sessionToken, presented)
                            ) {
                                return Result.err(sessionRevoked())
                            }
                            return user.email === null || user.email === ''
                                ? Result.ok(undefined)
                                : Result.err(conflict('Email is already linked to this account'))
                        },
                        apply: async (user, tx) => {
                            const updated = await userRepository.update(
                                user.id,
                                { email: targetEmail, emailVerifiedAt: new Date() },
                                tx,
                            )
                            if (updated === undefined)
                                throw new Error('User disappeared during linking')
                        },
                        invalidate: [emailLinkVerificationRepository],
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
            const linkError = tokenOutcomeError(linked, usedMessage, expiredMessage)
            if (linkError !== undefined) return Result.err(linkError)

            return Result.ok({ message: 'Email linked successfully' })
        }

        // feat-097: who opens a registration link must be the account's owner: signed in to
        // it, or knowing its password. Checked before the transaction, so a wrong password
        // does not use the link up.
        const owner = await userRepository.findById(verification.userId)
        if (owner === undefined) {
            return Result.err(notFound('User', 'User not found'))
        }
        const ownSession =
            requester.userId === owner.id &&
            requester.presentedSessionToken !== undefined &&
            safeEqual(requester.presentedSessionToken, owner.sessionToken)
        if (!ownSession && owner.emailVerifiedAt === null) {
            const passwordResult = await checkOwnerPassword(owner, requester.password)
            if (Result.isError(passwordResult)) return Result.err(passwordResult.error)
        }

        // feat-096: the verification is applied under the user lock, see the link branch.
        const verified = await runTokenTransaction(emailVerificationRepository, verification, {
            apply: async (user, tx) => {
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
            invalidate: [emailVerificationRepository],
        })
        const verifyError = tokenOutcomeError(verified, usedMessage, expiredMessage)
        if (verifyError !== undefined) return Result.err(verifyError)

        return Result.ok({ message: 'Email confirmed successfully' })
    },

    async queueVerificationEmail(
        userId: bigint,
        /**
         * feat-129: checked right before the mail is queued; a logout in another tab deletes this
         * session's record without rotating users.session_token.
         */
        sessionStored: () => Promise<boolean>,
    ): Promise<AppResult<{ message: string }>> {
        const throttle = await enforceThrottle(
            throttlePolicies.resendVerificationUser,
            String(userId),
            rateLimited('Too many verification emails requested. Please try again later.'),
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

        if (!(await sessionStored())) {
            return Result.err(sessionRevoked())
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

    /**
     * `presentedSessionToken`: the token of the session that asked (`Auth.getPresentedUserToken`).
     * The link is issued only while it is still the user's current one (feat-096).
     */
    async sendLinkVerificationEmail(
        userId: bigint,
        targetEmail: string,
        presentedSessionToken: string | undefined,
    ): Promise<AppResult<{ message: string }>> {
        const issued = await issueTokenLocked(emailLinkVerificationRepository, {
            userId,
            ttlMs: EMAIL_VERIFICATION_TTL_MS,
            extra: { targetEmail },
            check: (user) => {
                if (
                    presentedSessionToken === undefined ||
                    !safeEqual(user.sessionToken, presentedSessionToken)
                ) {
                    return Result.err(sessionRevoked())
                }
                if (user.email !== null && user.email !== '') {
                    return Result.err(badRequest('Email is already linked to this account'))
                }
                return Result.ok(undefined)
            },
        })
        if (Result.isError(issued)) {
            return Result.err(issued.error)
        }
        const { rawToken, user } = issued.value

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
