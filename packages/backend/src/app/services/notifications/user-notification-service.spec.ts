import { afterEach, describe, expect, it, vi } from 'vitest'

// Business-event notices (code-issues item 72, feat-236): each security event becomes a kind of
// the notification catalog with its params, and a support reply is `support.reply`. The delivery
// itself (row, signal, push) is notification-service.ts; here only what is handed to it.
const notify = vi.fn()
vi.mock('#app/services/notifications/notification-service.js', () => ({
    notificationService: { notify },
}))

const { userNotificationService } = await import('./user-notification-service.js')

afterEach(() => {
    vi.clearAllMocks()
})

describe('userNotificationService', () => {
    it.each([
        ['password_changed', 'security.password_changed'],
        ['password_reset', 'security.password_reset'],
        ['logout_all', 'security.logout_all'],
        ['account_claimed', 'security.account_claimed'],
    ] as const)('security %s → %s with no params', (event, kind) => {
        userNotificationService.security(7n, event)
        expect(notify).toHaveBeenCalledWith(7n, kind, {})
    })

    it('passes the params of the kind', () => {
        userNotificationService.security(7n, 'new_sign_in', { device: 'Chrome on macOS' })
        userNotificationService.security(7n, 'sign_in_method_added', { provider: 'github' })
        userNotificationService.security(7n, 'sign_in_method_removed', { provider: 'gitlab' })
        userNotificationService.security(7n, 'session_revoked')

        expect(notify.mock.calls).toEqual([
            [7n, 'security.new_sign_in', { device: 'Chrome on macOS' }],
            [7n, 'security.method_added', { provider: 'github' }],
            [7n, 'security.method_removed', { provider: 'gitlab' }],
            [7n, 'security.session_revoked', {}],
        ])
    })

    it('support reply is support.reply', () => {
        userNotificationService.supportReply(7n)
        expect(notify).toHaveBeenCalledWith(7n, 'support.reply', {})
    })
})
