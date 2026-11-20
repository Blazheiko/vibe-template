import { Result } from 'better-result'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as SharedNotifications from 'shared/notifications'

// feat-236 (Р5): a security mail is its call site's own flow. Whatever `notify` runs into — its
// checks refuse the notification, the row cannot be stored, the push fails — the mail still goes.
// The notification service is real here; only what it depends on fails.

vi.hoisted(() => {
    process.env['APP_KEY'] ??= 'k'.repeat(16) + '3f9a1c7e5b2d4f60'
    process.env['FRONTEND_URL'] = 'https://app.example.com'
})

type Failure = 'checks' | 'insert' | 'push'
const state = vi.hoisted(() => ({ failure: 'insert' }))

const send = vi.hoisted(() => vi.fn())
const insert = vi.hoisted(() => vi.fn())
const sendToUser = vi.hoisted(() => vi.fn())
const publishToUser = vi.hoisted(() => vi.fn())
const findUser = vi.hoisted(() => vi.fn())
const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }))

vi.mock('shared/notifications', async (importOriginal) => {
    const actual = await importOriginal<typeof SharedNotifications>()
    return {
        ...actual,
        // A link the checks refuse: the notification is dropped before anything is stored.
        buildNotificationLink: (...args: Parameters<typeof actual.buildNotificationLink>) =>
            state.failure === 'checks' ? '//evil.example' : actual.buildNotificationLink(...args),
    }
})
vi.mock('#app/repositories/index.js', () => ({
    notificationRepository: { insert },
    userRepository: { findById: findUser },
    userPreferencesRepository: { findByUserId: vi.fn(() => Promise.resolve(null)) },
    oauthAccountRepository: { findByUserId: vi.fn(() => Promise.resolve([])) },
}))
vi.mock('#app/services/notifications/push-notification-sender-service.js', () => ({
    pushNotificationSenderService: { sendToUser },
}))
vi.mock('#app/services/communication/user-event-bus.js', () => ({
    userEventBus: { publishToUser },
}))
vi.mock('#app/services/notifications/email-service.js', () => ({ emailService: { send } }))
vi.mock('#app/services/auth/auth-throttle-service.js', () => ({
    consumeAuthThrottle: vi.fn(() => Promise.resolve({ allowed: true, count: 1 })),
}))
vi.mock('#vendor/utils/session/redis-session-storage.js', () => ({
    listSessions: vi.fn(() => Promise.resolve({ sessions: [], next: null })),
}))
vi.mock('#vendor/utils/logger.js', () => ({ default: log }))
vi.mock('#logger', () => ({ default: log }))

const { notifyNewSignIn } = await import('#app/services/auth/new-sign-in-notice.js')
const { notifySignInMethodAdded } = await import('#app/services/auth/sign-in-method-notice.js')
const { announcePasswordReset } = await import('#app/services/auth/password-reset-notice.js')
const { userNotificationService } = await import('./user-notification-service.js')

const settle = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve))
}

const arrange = (failure: Failure): void => {
    state.failure = failure
    insert.mockImplementation(() =>
        failure === 'insert' ? Promise.reject(new Error('db down')) : Promise.resolve(9n),
    )
    sendToUser.mockImplementation(() =>
        failure === 'push'
            ? Promise.reject(new Error('push down'))
            : Promise.resolve({ sent: 1, failed: 0 }),
    )
}

beforeEach(() => {
    vi.clearAllMocks()
    send.mockResolvedValue(Result.ok(undefined))
    publishToUser.mockResolvedValue(undefined)
    findUser.mockResolvedValue({
        id: 7n,
        name: 'Jane',
        email: 'jane@example.com',
        emailVerifiedAt: new Date('2026-01-01T00:00:00Z'),
        sessionToken: 'userToken',
    })
})

const FAILURES: Failure[] = ['checks', 'insert', 'push']

describe.each(FAILURES)('notify fails at %s', (failure) => {
    it('the new sign-in mail still goes', async () => {
        arrange(failure)
        notifyNewSignIn(
            7n,
            {
                publicId: 'n'.repeat(22),
                ip: '203.0.113.7',
                userAgent:
                    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                method: 'password',
                signedInAt: '2026-11-19T12:30:00.000Z',
            },
            { mail: true },
        )
        await vi.waitFor(() => {
            expect(send).toHaveBeenCalledOnce()
        })
        expect(send.mock.calls[0]?.[0]).toMatchObject({ to: 'jane@example.com' })
    })

    it('the sign-in method mail still goes', async () => {
        arrange(failure)
        notifySignInMethodAdded({
            userId: 7n,
            email: 'jane@example.com',
            name: 'Jane',
            provider: 'github',
            providerName: null,
        })
        await vi.waitFor(() => {
            expect(send).toHaveBeenCalledOnce()
        })
    })

    it.each(['password_reset', 'account_claimed'] as const)(
        'the password reset mail still goes after %s',
        async (event) => {
            arrange(failure)
            // As password-reset-service.ts does: the notice, then the reset mail in both branches.
            userNotificationService.security(7n, event)
            await announcePasswordReset({ userId: 7n, email: 'jane@example.com', name: 'Jane' })
            await vi.waitFor(() => {
                expect(send).toHaveBeenCalledOnce()
            })
        },
    )

    it('the failure is the one arranged', async () => {
        arrange(failure)
        userNotificationService.security(7n, 'logout_all')
        await settle()
        if (failure === 'checks') {
            expect(insert).not.toHaveBeenCalled()
            expect(sendToUser).not.toHaveBeenCalled()
        } else {
            expect(insert).toHaveBeenCalledOnce()
            expect(sendToUser).toHaveBeenCalledOnce()
        }
    })
})
