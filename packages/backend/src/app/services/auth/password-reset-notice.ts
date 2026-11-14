import { Result } from 'better-result'
import { PRODUCT } from 'shared/product'

import appConfig from '#config/app.js'
import { oauthAccountRepository } from '#app/repositories/index.js'
import { providerTitle } from '#app/services/auth/oauth-provider-titles.js'
import { emailService } from '#app/services/notifications/email-service.js'
import { renderBrandedEmail } from '#app/services/notifications/email-templates.js'
import logger from '#vendor/utils/logger.js'

// feat-199 (decision Д2 of the security review 2026-11-12 plan): a password reset does not
// remove the identities of OAuth providers linked to the account, and they keep signing in.
// Somebody who resets the password because the account was taken over must learn that: the
// reset answers with the providers still linked (the page shows them), and the mail that
// confirms the reset lists them and points to the account page, where they are removed.

export function renderPasswordResetNoticeEmail(notice: {
    name: string
    providers: readonly string[]
}): ReturnType<typeof renderBrandedEmail> {
    const url = `${appConfig.frontendUrl}/account`
    const reset = `The password of your ${PRODUCT.name} account was reset, and every other session was signed out.`
    const titles = notice.providers.map(providerTitle).join(', ')
    const linked =
        notice.providers.length === 0
            ? 'If it was not you, reset the password again and contact support.'
            : `These sign-in methods are still linked to the account and keep working after a password reset: ${titles}. If you do not recognise one, sign in and remove it on the account page.`
    return renderBrandedEmail({
        subject: 'Your password was reset',
        eyebrow: 'Security notice',
        title: 'Your password was reset',
        name: notice.name,
        intro: reset,
        action: { kind: 'link', url },
        footer: linked,
        textLines: [reset, '', linked, url],
    })
}

const sendMail = async (
    userId: bigint,
    to: string,
    name: string,
    providers: readonly string[],
): Promise<void> => {
    const content = renderPasswordResetNoticeEmail({ name, providers })
    const sent = await emailService.send({
        to,
        subject: content.subject,
        text: content.text,
        html: content.html,
    })
    if (Result.isError(sent)) {
        logger.warn(
            { error: sent.error._tag, userId: String(userId) },
            'Password reset: the notice was not mailed',
        )
    }
}

/**
 * The providers still linked after a committed reset, and the mail about it to the account's
 * address (none for an account without one). Never fails the reset: a read that fails answers
 * an empty list, a mail that fails is logged.
 */
export async function announcePasswordReset(account: {
    userId: bigint
    email: string | null
    name: string
}): Promise<string[]> {
    let providers: string[] = []
    try {
        const links = await oauthAccountRepository.findByUserId(account.userId)
        providers = [...new Set(links.map((link) => link.provider))].sort()
    } catch (err: unknown) {
        logger.warn(
            { err, userId: String(account.userId) },
            'Password reset: the linked sign-in methods could not be read',
        )
    }
    const { email } = account
    if (email !== null && email !== '') {
        sendMail(account.userId, email, account.name, providers).catch((err: unknown) => {
            logger.warn(
                { err, userId: String(account.userId) },
                'Password reset: the notice was not mailed',
            )
        })
    }
    return providers
}
