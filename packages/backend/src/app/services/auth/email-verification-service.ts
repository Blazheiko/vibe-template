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
import { consumeAuthThrottle } from '#app/services/auth/auth-throttle-service.js'
import { throttlePolicies } from '#config/throttle-policies.js'

const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000
const EMAIL_BRAND = {
    accent: '#A8627A',
    accentHover: '#96516A',
    canvas: '#FAF0F3',
    surface: '#FFFFFF',
    textPrimary: '#2C3440',
    textSecondary: '#5E6977',
    border: '#D8DDE6',
    accentSoft: '#F6E8EE',
    accentLine: '#E7C8D3',
} as const

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

function buildLinkEmailContent(
    name: string,
    verificationUrl: string,
): {
    subject: string
    text: string
    html: string
} {
    const subject = 'Confirm your new email'
    const trimmedName = name.trim()
    const safeName = trimmedName === '' ? '' : `, ${trimmedName}`
    const escapedGreeting = trimmedName === '' ? '' : `, ${escapeHtml(trimmedName)}`
    const escapedVerificationUrl = escapeHtml(verificationUrl)

    const text = [
        `Hello${safeName}.`,
        '',
        'Please confirm this new email address for your Vibe Template account by opening this link:',
        verificationUrl,
        '',
        'This link will expire in 24 hours.',
    ].join('\n')

    const html = `<!DOCTYPE html>
<html lang="en">
  <body style="margin:0;padding:0;background:${EMAIL_BRAND.canvas};font-family:Inter,Arial,sans-serif;color:${EMAIL_BRAND.textPrimary};">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:${EMAIL_BRAND.canvas};padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:640px;">
            <tr>
              <td style="padding-bottom:16px;">
                <div style="display:inline-block;padding:8px 14px;border-radius:999px;background:${EMAIL_BRAND.accentSoft};border:1px solid ${EMAIL_BRAND.accentLine};color:${EMAIL_BRAND.accent};font-size:12px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;">
                  Vibe Template
                </div>
              </td>
            </tr>
            <tr>
              <td style="border-radius:28px;background:${EMAIL_BRAND.surface};border:1px solid ${EMAIL_BRAND.border};box-shadow:0 18px 48px rgba(44,52,64,0.08);overflow:hidden;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                  <tr>
                    <td style="padding:40px 40px 24px;background:linear-gradient(180deg, rgba(168,98,122,0.16) 0%, rgba(168,98,122,0.05) 100%);border-bottom:1px solid ${EMAIL_BRAND.border};">
                      <div style="font-size:13px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${EMAIL_BRAND.accent};margin-bottom:14px;">
                        Email linking
                      </div>
                      <h1 style="margin:0;font-size:34px;line-height:1.12;font-weight:800;color:${EMAIL_BRAND.textPrimary};">
                        Confirm your new email address
                      </h1>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:32px 40px 40px;">
                      <p style="margin:0 0 18px;font-size:18px;line-height:1.65;color:${EMAIL_BRAND.textPrimary};">
                        Hello${escapedGreeting}.
                      </p>
                      <p style="margin:0 0 28px;font-size:17px;line-height:1.7;color:${EMAIL_BRAND.textSecondary};">
                        Confirm this email to finish linking it to your Vibe Template account.
                      </p>
                      <p style="margin:0 0 28px;font-size:15px;line-height:1.65;color:${EMAIL_BRAND.textSecondary};word-break:break-word;">
                        <a href="${escapedVerificationUrl}" style="color:${EMAIL_BRAND.accent};text-decoration:underline;">
                          ${escapedVerificationUrl}
                        </a>
                      </p>
                      <div style="padding-top:20px;border-top:1px solid ${EMAIL_BRAND.border};font-size:14px;line-height:1.7;color:${EMAIL_BRAND.textSecondary};">
                        This link will expire in 24 hours. If you did not request this change, you can safely ignore this email.
                      </div>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`

    return { subject, text, html }
}

function escapeHtml(value: string): string {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;')
}

function buildEmailContent(
    name: string,
    verificationUrl: string,
): {
    subject: string
    text: string
    html: string
} {
    const subject = 'Confirm your email'
    const trimmedName = name.trim()
    const safeName = trimmedName === '' ? '' : `, ${trimmedName}`
    const escapedGreeting = trimmedName === '' ? '' : `, ${escapeHtml(trimmedName)}`
    const escapedVerificationUrl = escapeHtml(verificationUrl)

    const text = [
        `Hello${safeName}.`,
        '',
        'Please confirm your email address by opening this link:',
        verificationUrl,
        '',
        'This link will expire in 24 hours.',
    ].join('\n')

    const html = `<!DOCTYPE html>
<html lang="en">
  <body style="margin:0;padding:0;background:${EMAIL_BRAND.canvas};font-family:Inter,Arial,sans-serif;color:${EMAIL_BRAND.textPrimary};">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;">
      Confirm your Vibe Template email address.
    </div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:${EMAIL_BRAND.canvas};padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:640px;">
            <tr>
              <td style="padding-bottom:16px;">
                <div style="display:inline-block;padding:8px 14px;border-radius:999px;background:${EMAIL_BRAND.accentSoft};border:1px solid ${EMAIL_BRAND.accentLine};color:${EMAIL_BRAND.accent};font-size:12px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;">
                  Vibe Template
                </div>
              </td>
            </tr>
            <tr>
              <td style="border-radius:28px;background:${EMAIL_BRAND.surface};border:1px solid ${EMAIL_BRAND.border};box-shadow:0 18px 48px rgba(44,52,64,0.08);overflow:hidden;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                  <tr>
                    <td style="padding:40px 40px 24px;background:linear-gradient(180deg, rgba(168,98,122,0.16) 0%, rgba(168,98,122,0.05) 100%);border-bottom:1px solid ${EMAIL_BRAND.border};">
                      <div style="font-size:13px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${EMAIL_BRAND.accent};margin-bottom:14px;">
                        Email verification
                      </div>
                      <h1 style="margin:0;font-size:34px;line-height:1.12;font-weight:800;color:${EMAIL_BRAND.textPrimary};">
                        Confirm your email address
                      </h1>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:32px 40px 40px;">
                      <p style="margin:0 0 18px;font-size:18px;line-height:1.65;color:${EMAIL_BRAND.textPrimary};">
                        Hello${escapedGreeting}.
                      </p>
                      <p style="margin:0 0 28px;font-size:17px;line-height:1.7;color:${EMAIL_BRAND.textSecondary};">
                        Finish setting up your Vibe Template account by confirming this email address. The button below will take you straight back into the app.
                      </p>
                      <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 28px;">
                        <tr>
                          <td align="center" bgcolor="${EMAIL_BRAND.accent}" style="border-radius:16px;box-shadow:0 14px 26px rgba(168,98,122,0.24);">
                            <a
                              href="${escapedVerificationUrl}"
                              style="display:inline-block;padding:17px 28px;font-size:17px;font-weight:700;line-height:1;color:#ffffff;text-decoration:none;border-radius:16px;background:${EMAIL_BRAND.accent};"
                            >
                              Confirm email
                            </a>
                          </td>
                        </tr>
                      </table>
                      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 24px;border-collapse:separate;">
                        <tr>
                          <td style="padding:18px 20px;border-radius:18px;background:${EMAIL_BRAND.accentSoft};border:1px solid ${EMAIL_BRAND.accentLine};">
                            <div style="margin:0 0 8px;font-size:13px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;color:${EMAIL_BRAND.accent};">
                              Alternative link
                            </div>
                            <div style="font-size:15px;line-height:1.65;color:${EMAIL_BRAND.textSecondary};word-break:break-word;">
                              If the button does not work, open this link:<br />
                              <a href="${escapedVerificationUrl}" style="color:${EMAIL_BRAND.accent};text-decoration:underline;">
                                ${escapedVerificationUrl}
                              </a>
                            </div>
                          </td>
                        </tr>
                      </table>
                      <div style="padding-top:20px;border-top:1px solid ${EMAIL_BRAND.border};font-size:14px;line-height:1.7;color:${EMAIL_BRAND.textSecondary};">
                        This link will expire in 24 hours. If you did not create an account, you can safely ignore this email.
                      </div>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`

    return { subject, text, html }
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
        const throttle = await tryInternal(
            () => consumeAuthThrottle(throttlePolicies.verifyEmailIp, requestMeta.ipAddress),
            'Failed to enforce email verification throttle',
        )
        if (Result.isError(throttle)) {
            return Result.err(throttle.error)
        }
        if (!throttle.value.allowed) {
            return Result.err(badRequest('Too many verification attempts. Please try again later.'))
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
                () => userRepository.findByEmail(linkVerification.targetEmail.toLowerCase()),
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
                                email: linkVerification.targetEmail.toLowerCase(),
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
        const throttle = await tryInternal(
            () => consumeAuthThrottle(throttlePolicies.resendVerificationUser, String(userId)),
            'Failed to enforce verification email throttle',
        )
        if (Result.isError(throttle)) {
            return Result.err(throttle.error)
        }
        if (!throttle.value.allowed) {
            return Result.err(
                badRequest('Too many verification emails requested. Please try again later.'),
            )
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
