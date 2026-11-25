import type { NotificationKind, NotificationParams } from 'shared/notifications'

import { notificationService } from '#app/services/notifications/notification-service.js'
import type { UserId } from '#app/domain/ids.js'

// Business events that notify the user (code-issues item 72, feat-236). Each one is stored in the
// notification center and pushed under the user's preferences (notification-service.ts). Never
// awaited and never throws: a failure does not change or delay the response that triggered it.

/** The security events of the call sites and the kind of the catalog each one is. */
const SECURITY_KINDS = {
    new_sign_in: 'security.new_sign_in',
    sign_in_method_added: 'security.method_added',
    sign_in_method_removed: 'security.method_removed',
    password_changed: 'security.password_changed',
    password_reset: 'security.password_reset',
    logout_all: 'security.logout_all',
    account_claimed: 'security.account_claimed',
    session_revoked: 'security.session_revoked',
    // feat-245 (Р14).
    mfa_enabled: 'security.mfa_enabled',
    mfa_disabled: 'security.mfa_disabled',
    recovery_codes_regenerated: 'security.recovery_codes_regenerated',
    recovery_code_used: 'security.recovery_code_used',
    // feat-246 (Р14).
    passkey_added: 'security.passkey_added',
    passkey_removed: 'security.passkey_removed',
    // feat-247 (Р13).
    mfa_reset: 'security.mfa_reset',
} as const satisfies Record<string, NotificationKind>

export type SecurityEvent = keyof typeof SECURITY_KINDS
type SecurityKindOf<E extends SecurityEvent> = (typeof SECURITY_KINDS)[E]

/** The arguments of an event: its params, which may be left out when none is required. */
type SecurityArgs<E extends SecurityEvent> =
    Partial<NotificationParams<SecurityKindOf<E>>> extends NotificationParams<SecurityKindOf<E>>
        ? [params?: NotificationParams<SecurityKindOf<E>>]
        : [params: NotificationParams<SecurityKindOf<E>>]

export const userNotificationService = {
    /** Security notices go to every device, online or not (Р5). */
    security<E extends SecurityEvent>(userId: UserId, event: E, ...args: SecurityArgs<E>): void {
        const kind: SecurityKindOf<E> = SECURITY_KINDS[event]
        const params = (args[0] ?? {}) as NotificationParams<SecurityKindOf<E>>
        notificationService.notify(userId, kind, params)
    },

    /** A support reply is pushed only when no device has the app open on this instance. */
    supportReply(userId: UserId): void {
        notificationService.notify(userId, 'support.reply', {})
    },
}
