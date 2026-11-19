import { afterEach, describe, expect, it, vi } from 'vitest'

// Business-event pushes (code-issues item 72): security notices as `system` to every
// device, support replies as `mention` only when the user is offline; never awaited.
const sendToUser = vi.fn()
vi.mock('#app/services/notifications/push-notification-sender-service.js', () => ({
    pushNotificationSenderService: { sendToUser },
}))
const warn = vi.fn()
vi.mock('#vendor/utils/logger.js', () => ({ default: { warn, info: vi.fn(), error: vi.fn() } }))

const { userNotificationService } = await import('./user-notification-service.js')

afterEach(() => {
    vi.clearAllMocks()
})

describe('userNotificationService', () => {
    it.each(['sign_in_method_added', 'password_changed', 'password_reset', 'logout_all'] as const)(
        'security %s: system push to every device',
        (event) => {
            sendToUser.mockResolvedValue({ sent: 1, failed: 0 })
            userNotificationService.security(7n, event)
            expect(sendToUser).toHaveBeenCalledWith(
                7n,
                expect.objectContaining({ title: expect.any(String), url: '/account' }),
                { notificationType: 'system' },
            )
        },
    )

    it('support reply: mention push, skipped while the user is online', () => {
        sendToUser.mockResolvedValue({ sent: 0, failed: 0 })
        userNotificationService.supportReply(7n)
        expect(sendToUser).toHaveBeenCalledWith(7n, expect.objectContaining({ url: '/support' }), {
            skipIfOnline: true,
            notificationType: 'mention',
        })
    })

    it.each(['new_sign_in', 'session_revoked'] as const)(
        'security %s links to the session list (feat-233)',
        (event) => {
            sendToUser.mockResolvedValue({ sent: 1, failed: 0 })
            userNotificationService.security(7n, event)
            expect(sendToUser).toHaveBeenCalledWith(
                7n,
                expect.objectContaining({ url: '/account#sessions' }),
                { notificationType: 'system' },
            )
        },
    )

    it('security details replace the text of the event, the rest stays', () => {
        sendToUser.mockResolvedValue({ sent: 1, failed: 0 })
        userNotificationService.security(7n, 'new_sign_in', {
            body: 'Signed in from Chrome on macOS.',
        })
        expect(sendToUser).toHaveBeenCalledWith(
            7n,
            {
                title: 'New sign-in',
                body: 'Signed in from Chrome on macOS.',
                url: '/account#sessions',
                tag: 'security-sign-in',
            },
            { notificationType: 'system' },
        )
    })

    it('a failing push is logged, not thrown', async () => {
        sendToUser.mockRejectedValue(new Error('db down'))
        expect(() => {
            userNotificationService.security(7n, 'new_sign_in')
        }).not.toThrow()
        await vi.waitFor(() => {
            expect(warn).toHaveBeenCalledOnce()
        })
    })
})
