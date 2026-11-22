import type { NotificationKind, NotificationParams } from 'shared/notifications'

// feat-236 (Р3): the text of the push of each kind, in English as before: the server has no
// localization. The history shows the same notification in the language of the interface,
// from `kind` and `params` (frontend locales).

export interface NotificationPushText {
    title: string
    body: string
    tag: string
}

type PushTexts = {
    readonly [K in NotificationKind]: (params: NotificationParams<K>) => NotificationPushText
}

export const NOTIFICATION_PUSH_TEXTS: PushTexts = {
    'security.new_sign_in': ({ device }) => ({
        title: 'New sign-in',
        body: `Signed in from ${device}. If it was not you, end that session and change your password.`,
        tag: 'security-sign-in',
    }),
    // feat-198: another provider's identity was linked. It signs in after a password change too.
    'security.method_added': () => ({
        title: 'New sign-in method',
        body: 'A new way to sign in was added to your account. If it was not you, remove it on the account page.',
        tag: 'security-sign-in-method',
    }),
    // feat-199: a linked identity was removed on the account page.
    'security.method_removed': () => ({
        title: 'Sign-in method removed',
        body: 'A way to sign in was removed from your account. If it was not you, change your password.',
        tag: 'security-sign-in-method',
    }),
    'security.password_changed': () => ({
        title: 'Password changed',
        body: 'Your password was changed. If it was not you, reset it now.',
        tag: 'security-password',
    }),
    'security.password_reset': () => ({
        title: 'Password reset',
        body: 'Your password was reset and other sessions were signed out.',
        tag: 'security-password',
    }),
    'security.logout_all': () => ({
        title: 'Signed out everywhere',
        body: 'All sessions of your account were signed out.',
        tag: 'security-sessions',
    }),
    // feat-233: one session was ended from the session list of another.
    'security.session_revoked': ({ device }) => ({
        title: 'Session ended',
        body:
            device === undefined
                ? 'One of your sessions was ended from another device. If it was not you, change your password.'
                : `Your session on ${device} was ended from another device. If it was not you, change your password.`,
        tag: 'security-sessions',
    }),
    'security.account_claimed': () => ({
        title: 'Account secured',
        body: 'Your email was confirmed. Earlier sign-in methods and sessions were removed.',
        tag: 'security-sessions',
    }),
    'security.mfa_enabled': () => ({
        title: 'Two-step sign-in changed',
        body: 'A second factor was added to your account. If it was not you, secure your account.',
        tag: 'security-mfa',
    }),
    'security.mfa_disabled': () => ({
        title: 'Two-step sign-in turned off',
        body: 'The second factor was removed from your account. If it was not you, secure your account.',
        tag: 'security-mfa',
    }),
    'security.recovery_codes_regenerated': () => ({
        title: 'New recovery codes',
        body: 'New recovery codes were created; the old ones no longer work.',
        tag: 'security-mfa',
    }),
    'security.recovery_code_used': () => ({
        title: 'Recovery code used',
        body: 'Someone signed in with a recovery code and other sessions were signed out. If it was not you, act now.',
        tag: 'security-mfa',
    }),
    'security.passkey_added': () => ({
        title: 'Passkey added',
        body: 'A passkey was added to your account. If it was not you, secure your account.',
        tag: 'security-mfa',
    }),
    'security.mfa_reset': () => ({
        title: 'Two-step sign-in was reset',
        body: 'An administrator removed the second factors of your account. Sign in and set them up again.',
        tag: 'security-mfa',
    }),
    'security.passkey_removed': () => ({
        title: 'Passkey removed',
        body: 'A passkey was removed from your account. If it was not you, secure your account.',
        tag: 'security-mfa',
    }),
    'support.reply': () => ({
        title: 'Support replied',
        body: 'A new answer is waiting in the support chat.',
        tag: 'support-reply',
    }),
}

export const pushTextOf = <K extends NotificationKind>(
    kind: K,
    params: NotificationParams<K>,
): NotificationPushText => NOTIFICATION_PUSH_TEXTS[kind](params)
