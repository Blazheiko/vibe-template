import { Result } from 'better-result'
import { PRODUCT } from 'shared/product'

import appConfig from '#config/app.js'
import { userRepository } from '#app/repositories/index.js'
import { emailService } from '#app/services/notifications/email-service.js'
import { renderBrandedEmail } from '#app/services/notifications/email-templates.js'
import { userNotificationService } from '#app/services/notifications/user-notification-service.js'
import logger from '#vendor/utils/logger.js'
import type { UserId } from '#app/domain/ids.js'

// feat-245 (docs/plan/passkeys-mfa-plan.md, Р14): a change of the second factors is a change of
// who can get into the account, so it is told by the notification center and by mail to the
// account's address (security mails are sent by their call sites, feat-236). Fire-and-forget:
// the change is committed already; a failed mail is logged, never undone.

export type MfaNoticeKind =
    | 'enabled'
    | 'replaced'
    | 'disabled'
    | 'recovery_codes_regenerated'
    | 'recovery_code_used'
    | 'passkey_added'
    | 'passkey_removed'
    | 'reset'

const TEXTS: Readonly<Record<MfaNoticeKind, { subject: string; title: string; what: string }>> = {
    enabled: {
        subject: 'Two-step sign-in was turned on',
        title: 'An authenticator app was added',
        what: `Signing in to your ${PRODUCT.name} account now also asks for a code from an authenticator app.`,
    },
    replaced: {
        subject: 'Your authenticator app was replaced',
        title: 'A new authenticator app was set up',
        what: `The authenticator app of your ${PRODUCT.name} account was replaced; the previous one no longer works.`,
    },
    disabled: {
        subject: 'Two-step sign-in was turned off',
        title: 'The authenticator app was removed',
        what: `Your ${PRODUCT.name} account no longer asks for a code from an authenticator app.`,
    },
    recovery_codes_regenerated: {
        subject: 'New recovery codes were created',
        title: 'New recovery codes',
        what: `New recovery codes were created for your ${PRODUCT.name} account; the previous ones no longer work.`,
    },
    recovery_code_used: {
        subject: 'A recovery code was used to sign in',
        title: 'Somebody signed in with a recovery code',
        what: `A recovery code was used to sign in to your ${PRODUCT.name} account, and its other sessions were signed out.`,
    },
    // feat-246 (Р14).
    passkey_added: {
        subject: 'A passkey was added to your account',
        title: 'A new passkey',
        what: `A passkey was added to your ${PRODUCT.name} account: it signs in without a password.`,
    },
    // feat-247 (Р13).
    reset: {
        subject: 'Two-step sign-in was reset by an administrator',
        title: 'Your second factors were removed',
        what: `An administrator removed the second factors and recovery codes of your ${PRODUCT.name} account and signed out its sessions. Sign in with your password and set up two-step sign-in again.`,
    },
    passkey_removed: {
        subject: 'A passkey was removed from your account',
        title: 'A passkey was removed',
        what: `A passkey was removed from your ${PRODUCT.name} account; it no longer signs in.`,
    },
}

const WARNING =
    'If it was not you, sign in, change your password and set up two-step sign-in again, or contact support.'

export function renderMfaNoticeEmail(
    kind: MfaNoticeKind,
    name: string,
): ReturnType<typeof renderBrandedEmail> {
    const text = TEXTS[kind]
    const url = `${appConfig.frontendUrl}/account`
    return renderBrandedEmail({
        subject: text.subject,
        eyebrow: 'Security notice',
        title: text.title,
        name,
        intro: text.what,
        action: { kind: 'link', url },
        footer: WARNING,
        textLines: [text.what, '', WARNING, url],
    })
}

const NOTIFICATION = {
    enabled: 'mfa_enabled',
    replaced: 'mfa_enabled',
    disabled: 'mfa_disabled',
    recovery_codes_regenerated: 'recovery_codes_regenerated',
    recovery_code_used: 'recovery_code_used',
    passkey_added: 'passkey_added',
    passkey_removed: 'passkey_removed',
    reset: 'mfa_reset',
} as const satisfies Record<MfaNoticeKind, string>

async function mail(userId: UserId, kind: MfaNoticeKind): Promise<void> {
    const user = await userRepository.findById(userId)
    if (user?.email === null || user?.email === undefined || user.email === '') return
    const content = renderMfaNoticeEmail(kind, user.name)
    const sent = await emailService.send({
        to: user.email,
        subject: content.subject,
        text: content.text,
        html: content.html,
    })
    if (Result.isError(sent)) {
        logger.warn(
            { error: sent.error._tag, userId: String(userId), kind },
            'MFA notice not mailed',
        )
    }
}

/** The notification and the mail of a committed change of the second factors. */
export function announceMfaChange(userId: UserId, kind: MfaNoticeKind): void {
    userNotificationService.security(userId, NOTIFICATION[kind])
    mail(userId, kind).catch((err: unknown) => {
        logger.warn({ err, userId: String(userId), kind }, 'MFA notice not mailed')
    })
}
