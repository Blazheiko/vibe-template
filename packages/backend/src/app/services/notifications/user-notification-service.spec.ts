import { afterEach, describe, expect, it, vi } from 'vitest'

// Business-event pushes (code-issues item 72): security notices to every device, support
// replies only when the user is offline; never awaited.
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
        'security %s: push to every device',
        (event) => {
            sendToUser.mockResolvedValue({ sent: 1, failed: 0 })
            userNotificationService.security(7n, event)
            expect(sendToUser).toHaveBeenCalledWith(
                7n,
                expect.objectContaining({ title: expect.any(String), url: '/account' }),
                {},
            )
        },
    )

    it('support reply: push skipped while the user is online', () => {
        sendToUser.mockResolvedValue({ sent: 0, failed: 0 })
        userNotificationService.supportReply(7n)
        expect(sendToUser).toHaveBeenCalledWith(7n, expect.objectContaining({ url: '/support' }), {
            skipIfOnline: true,
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
                {},
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
            {},
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
