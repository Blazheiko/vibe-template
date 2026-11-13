import { Result } from 'better-result'
import { PRODUCT } from 'shared/product'

import appConfig from '#config/app.js'
import { emailService } from '#app/services/notifications/email-service.js'
import {
    mailSafeDisplayName,
    renderBrandedEmail,
} from '#app/services/notifications/email-templates.js'
import { userNotificationService } from '#app/services/notifications/user-notification-service.js'
import logger from '#vendor/utils/logger.js'

// feat-198 (security review 2026-11-12, M-2): linking an identity of another provider to an
// account adds a way to sign in that outlives a password change, a password reset and "log out
// everywhere". It used to be announced as an ordinary "new sign-in", by push only, so the owner
// of an account whose mailbox somebody else could read for a moment had no way to notice it.
// The notice says what happened, by push and by mail to the account's address.

export interface SignInMethodAdded {
    userId: bigint
    /** The account's address; null for an account without one (nothing is mailed). */
    email: string | null
    name: string
    /** The provider's name as shown to people: "GitHub". */
    providerTitle: string
    /** The profile name the provider reported: outside data, quoted only when it is harmless. */
    providerName: string | null
}

export function renderSignInMethodAddedEmail(
    notice: Pick<SignInMethodAdded, 'name' | 'providerTitle' | 'providerName'>,
): ReturnType<typeof renderBrandedEmail> {
    const { providerTitle } = notice
    const profile = notice.providerName === null ? null : mailSafeDisplayName(notice.providerName)
    const who =
        profile === null
            ? `A ${providerTitle} account`
            : `The ${providerTitle} account "${profile}"`
    const what = `${who} was linked to your ${PRODUCT.name} account. It can now be used to sign in.`
    const warning = `If it was not you, contact support right away: this sign-in method keeps working after a password change.`
    const url = `${appConfig.frontendUrl}/support`
    return renderBrandedEmail({
        subject: `A new sign-in method was added to your account`,
        eyebrow: 'Security notice',
        title: `${providerTitle} was linked to your account`,
        name: notice.name,
        intro: what,
        action: { kind: 'link', url },
        footer: warning,
        textLines: [what, '', warning, url],
    })
}

const sendMail = async (notice: SignInMethodAdded, to: string): Promise<void> => {
    const content = renderSignInMethodAddedEmail(notice)
    const sent = await emailService.send({
        to,
        subject: content.subject,
        text: content.text,
        html: content.html,
    })
    if (Result.isError(sent)) {
        logger.warn(
            { error: sent.error._tag, userId: String(notice.userId) },
            'Sign-in method added: the notice was not mailed',
        )
    }
}

/**
 * Fire-and-forget, like every security notice: the link is committed already, and a mail or
 * push service that fails or is slow must not change or delay the sign-in that follows.
 */
export function notifySignInMethodAdded(notice: SignInMethodAdded): void {
    userNotificationService.security(notice.userId, 'sign_in_method_added')
    const { email } = notice
    if (email === null || email === '') return
    sendMail(notice, email).catch((err: unknown) => {
        logger.warn(
            { err, userId: String(notice.userId) },
            'Sign-in method added: the notice was not mailed',
        )
    })
}
