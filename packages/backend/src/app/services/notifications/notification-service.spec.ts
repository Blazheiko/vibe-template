import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { uid } from '../../../test-support/ids.js'

// feat-236 (Р5): the steps of a notification in order — checks, row, signal, push — and what a
// failure of each one leaves. `notify` never throws; `deliver` is the same work, awaited.
const insert = vi.hoisted(() => vi.fn())
const publishToUser = vi.hoisted(() => vi.fn())
const sendToUser = vi.hoisted(() => vi.fn())
const log = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }))

vi.mock('#app/repositories/index.js', () => ({ notificationRepository: { insert } }))
vi.mock('#app/services/communication/user-event-bus.js', () => ({
    userEventBus: { publishToUser },
}))
vi.mock('#app/services/notifications/push-notification-sender-service.js', () => ({
    pushNotificationSenderService: { sendToUser },
}))
vi.mock('#vendor/utils/logger.js', () => ({ default: log }))

const { notificationService, notificationOpenPath } = await import('./notification-service.js')

beforeEach(() => {
    insert.mockResolvedValue(41n)
    publishToUser.mockResolvedValue(undefined)
    sendToUser.mockResolvedValue({ sent: 1, failed: 0 })
})

afterEach(() => {
    vi.clearAllMocks()
})

describe('notificationService.deliver', () => {
    it('stores, signals and pushes with the open path of the stored row', async () => {
        const outcome = await notificationService.deliver(uid(7), 'security.new_sign_in', {
            device: 'Chrome on macOS',
        })

        expect(outcome).toEqual({ valid: true, id: 41n, signalled: true, pushed: true })
        expect(insert).toHaveBeenCalledWith({
            userId: uid(7),
            category: 'security',
            kind: 'security.new_sign_in',
            params: { device: 'Chrome on macOS' },
            link: '/account#sessions',
        })
        expect(publishToUser).toHaveBeenCalledWith('7', 'notifications_changed', {})
        expect(sendToUser).toHaveBeenCalledWith(
            7n,
            {
                title: 'New sign-in',
                body: 'Signed in from Chrome on macOS. If it was not you, end that session and change your password.',
                tag: 'security-sign-in',
                url: '/notifications/41/open',
                data: { notificationId: '41' },
            },
            { category: 'security' },
        )
        expect(notificationOpenPath(41n)).toBe('/notifications/41/open')
    })

    it.each([
        ['an undeclared key', 'security.new_sign_in', { device: 'x', ip: '203.0.113.5' }],
        ['a missing key', 'security.method_added', {}],
        ['a provider outside the catalog', 'security.method_added', { provider: 'myspace' }],
        ['a string over 128 characters', 'security.new_sign_in', { device: 'x'.repeat(129) }],
    ])('refuses %s: nothing stored, signalled or pushed', async (_label, kind, params) => {
        const outcome = await notificationService.deliver(
            uid(7),
            kind as 'security.new_sign_in',
            params as { device: string },
        )

        expect(outcome).toEqual({ valid: false, id: null, signalled: false, pushed: false })
        expect(insert).not.toHaveBeenCalled()
        expect(publishToUser).not.toHaveBeenCalled()
        expect(sendToUser).not.toHaveBeenCalled()
        expect(log.error).toHaveBeenCalledWith(
            expect.objectContaining({ userId: '7', kind }),
            'Notification refused by its checks',
        )
    })

    it('a failed insert: no signal, the push goes to the link of the kind without an id', async () => {
        insert.mockRejectedValue(new Error('db down'))

        const outcome = await notificationService.deliver(uid(7), 'security.password_changed', {})

        expect(outcome).toEqual({ valid: true, id: null, signalled: false, pushed: true })
        expect(publishToUser).not.toHaveBeenCalled()
        const payload = sendToUser.mock.calls[0]?.[1] as Record<string, unknown>
        expect(payload['url']).toBe('/account')
        expect(payload).not.toHaveProperty('data')
        expect(log.warn).toHaveBeenCalledWith(
            expect.objectContaining({ kind: 'security.password_changed' }),
            'Notification not stored; the push goes without it',
        )
    })

    it('a failed signal: the push still goes', async () => {
        publishToUser.mockRejectedValue(new Error('redis down'))

        const outcome = await notificationService.deliver(uid(7), 'security.logout_all', {})

        expect(outcome).toEqual({ valid: true, id: 41n, signalled: false, pushed: true })
        expect(sendToUser).toHaveBeenCalledOnce()
    })

    it('a failed push: the row and the signal are there already', async () => {
        sendToUser.mockRejectedValue(new Error('push down'))

        const outcome = await notificationService.deliver(uid(7), 'security.logout_all', {})

        expect(outcome).toEqual({ valid: true, id: 41n, signalled: true, pushed: false })
        expect(insert).toHaveBeenCalledOnce()
        expect(publishToUser).toHaveBeenCalledOnce()
    })

    it('a support reply is pushed only while the user is offline on this instance', async () => {
        await notificationService.deliver(uid(7), 'support.reply', {})

        expect(sendToUser).toHaveBeenCalledWith(
            7n,
            expect.objectContaining({ url: '/notifications/41/open' }),
            { category: 'support', skipIfOnline: true },
        )
        expect(insert).toHaveBeenCalledWith(
            expect.objectContaining({ category: 'support', link: '/support' }),
        )
    })
})

describe('notificationService.notify', () => {
    it('returns at once and never throws, whatever fails', async () => {
        insert.mockRejectedValue(new Error('db down'))
        publishToUser.mockRejectedValue(new Error('redis down'))
        sendToUser.mockRejectedValue(new Error('push down'))

        expect(() => {
            notificationService.notify(uid(7), 'security.logout_all', {})
            notificationService.notify(uid(7), 'security.new_sign_in', { device: '' })
        }).not.toThrow()

        await vi.waitFor(() => {
            expect(sendToUser).toHaveBeenCalledOnce()
        })
    })
})
