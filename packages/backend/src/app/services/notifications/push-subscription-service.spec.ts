import { Result } from 'better-result'
import { uid } from '../../../test-support/ids.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PushSubscriptionId, UserId } from '#app/domain/ids.js'

const pushSubscriptionRepositoryMock = {
    findByUserIdWithLogs: vi.fn(),
    findByEndpoint: vi.fn(),
    countByUserId: vi.fn().mockResolvedValue(0),
    updateByEndpoint: vi.fn(),
    create: vi.fn(),
    findByIdAndUserId: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    getLogsBySubscriptionId: vi.fn(),
    deactivate: vi.fn(),
}

const pushSubscriptionTransformerMock = {
    serialize: vi.fn((value: unknown) => ({ serialized: value })),
    serializeArrayWithLogs: vi.fn((value: unknown) => ({
        serializedArray: value,
    })),
}

const getPushSubscriptionStatisticsMock = vi.fn()

vi.mock('#app/repositories/index.js', () => ({
    pushSubscriptionRepository: pushSubscriptionRepositoryMock,
}))

const withCurrentSessionMock = vi.fn(
    (_userId: UserId, _token: string | undefined, work: (tx: unknown) => Promise<unknown>) =>
        work(TX),
)
const TX = { tx: true }

vi.mock('#app/services/auth/session-guard.js', () => ({
    withCurrentSession: withCurrentSessionMock,
}))

vi.mock('#app/transformers/index.js', () => ({
    pushSubscriptionTransformer: pushSubscriptionTransformerMock,
}))

vi.mock('#app/services/statistics/push-subscription-statistics-service.js', () => ({
    getPushSubscriptionStatistics: getPushSubscriptionStatisticsMock,
}))

async function loadPushSubscriptionService() {
    return import('./push-subscription-service.js')
}

afterEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
})

describe('pushSubscriptionService', () => {
    it('returns serialized subscriptions', async () => {
        pushSubscriptionRepositoryMock.findByUserIdWithLogs.mockResolvedValue([{ id: 1n }])

        const { pushSubscriptionService } = await loadPushSubscriptionService()
        const result = await pushSubscriptionService.getSubscriptions(uid(7))

        expect(Result.isOk(result)).toBe(true)
        if (Result.isOk(result)) {
            expect(result.value).toEqual({
                subscriptions: { serializedArray: [{ id: 1n }] },
            })
        }
    })

    it('updates an existing subscription', async () => {
        pushSubscriptionRepositoryMock.findByEndpoint.mockResolvedValue({
            id: 1n,
            userId: uid(7),
            endpoint: 'https://fcm.googleapis.com/fcm/send/ep',
            p256dhKey: 'old-key',
            authKey: 'old-auth',
        })
        pushSubscriptionRepositoryMock.updateByEndpoint.mockResolvedValue({
            id: 1n,
            endpoint: 'https://fcm.googleapis.com/fcm/send/ep',
        })

        const { pushSubscriptionService } = await loadPushSubscriptionService()
        const result = await pushSubscriptionService.createSubscription(
            uid(7),
            {
                endpoint: 'https://fcm.googleapis.com/fcm/send/ep',
                p256dhKey: 'key',
                authKey: 'auth',
            },
            'token-7',
        )

        expect(Result.isOk(result)).toBe(true)
        if (Result.isOk(result)) {
            expect(result.value).toEqual({
                subscription: {
                    serialized: { id: 1n, endpoint: 'https://fcm.googleapis.com/fcm/send/ep' },
                },
            })
        }
    })

    it('writes inside the session guard, with its transaction', async () => {
        pushSubscriptionRepositoryMock.findByEndpoint.mockResolvedValue(undefined)
        pushSubscriptionRepositoryMock.create.mockResolvedValue({ id: 2n })

        const { pushSubscriptionService } = await loadPushSubscriptionService()
        await pushSubscriptionService.createSubscription(
            uid(7),
            { endpoint: 'https://fcm.googleapis.com/fcm/send/new', p256dhKey: 'k', authKey: 'a' },
            'token-7',
        )

        expect(withCurrentSessionMock).toHaveBeenCalledWith(7n, 'token-7', expect.any(Function))
        expect(pushSubscriptionRepositoryMock.findByEndpoint).toHaveBeenCalledWith(
            'https://fcm.googleapis.com/fcm/send/new',
            TX,
        )
        expect(pushSubscriptionRepositoryMock.create).toHaveBeenCalledWith(
            expect.objectContaining({ userId: uid(7) }),
            TX,
        )
    })

    it('does not write when the session guard refuses', async () => {
        withCurrentSessionMock.mockResolvedValueOnce(
            Result.err({ _tag: 'Unauthorized', reason: 'session_revoked' }),
        )

        const { pushSubscriptionService } = await loadPushSubscriptionService()
        const created = await pushSubscriptionService.createSubscription(
            uid(7),
            { endpoint: 'https://fcm.googleapis.com/fcm/send/new', p256dhKey: 'k', authKey: 'a' },
            'stale-token',
        )
        withCurrentSessionMock.mockResolvedValueOnce(
            Result.err({ _tag: 'Unauthorized', reason: 'session_revoked' }),
        )
        const updated = await pushSubscriptionService.updateSubscription(
            uid(7),
            1n as PushSubscriptionId,
            { isActive: true },
            'stale-token',
        )

        expect(Result.isError(created)).toBe(true)
        expect(Result.isError(updated)).toBe(true)
        expect(pushSubscriptionRepositoryMock.findByEndpoint).not.toHaveBeenCalled()
        expect(pushSubscriptionRepositoryMock.create).not.toHaveBeenCalled()
        expect(pushSubscriptionRepositoryMock.update).not.toHaveBeenCalled()
    })

    // feat-252: a sign-out the server refused puts the record back in the state it had.
    describe('the state a record is written in', () => {
        const endpoint = 'https://fcm.googleapis.com/fcm/send/state'

        it.each([
            ['active without isActive', {}, true],
            ['disabled with isActive: false', { isActive: false }, false],
            ['active with isActive: true', { isActive: true }, true],
        ])('creates a new record %s', async (_name, extra, isActive) => {
            pushSubscriptionRepositoryMock.findByEndpoint.mockResolvedValue(undefined)
            pushSubscriptionRepositoryMock.create.mockResolvedValue({ id: 2n })

            const { pushSubscriptionService } = await loadPushSubscriptionService()
            await pushSubscriptionService.createSubscription(
                uid(7),
                { endpoint, p256dhKey: 'k', authKey: 'a', ...extra },
                'token-7',
            )

            expect(pushSubscriptionRepositoryMock.create).toHaveBeenCalledWith(
                expect.objectContaining({ isActive }),
                TX,
            )
        })

        it.each([
            ['active without isActive', {}, true],
            ['disabled with isActive: false', { isActive: false }, false],
        ])('writes an existing record %s', async (_name, extra, isActive) => {
            pushSubscriptionRepositoryMock.findByEndpoint.mockResolvedValue({
                id: 1n,
                userId: uid(7),
                endpoint,
                p256dhKey: 'k',
                authKey: 'a',
            })
            pushSubscriptionRepositoryMock.updateByEndpoint.mockResolvedValue({ id: 1n })

            const { pushSubscriptionService } = await loadPushSubscriptionService()
            await pushSubscriptionService.createSubscription(
                uid(7),
                { endpoint, p256dhKey: 'k', authKey: 'a', ...extra },
                'token-7',
            )

            expect(pushSubscriptionRepositoryMock.updateByEndpoint).toHaveBeenCalledWith(
                7n,
                endpoint,
                expect.objectContaining({ isActive }),
                TX,
            )
        })
    })

    // feat-254: a sign-out that went through removes this browser's record of the user.
    describe('deleteOwnSubscriptionByEndpoint', () => {
        const EP = 'https://FCM.googleapis.com/fcm/send/a%2fb'

        it('deletes the record of the user, found by the canonical endpoint', async () => {
            pushSubscriptionRepositoryMock.findByEndpoint.mockResolvedValue({
                id: 3n,
                userId: uid(7),
            })
            pushSubscriptionRepositoryMock.delete.mockResolvedValue(true)

            const { pushSubscriptionService } = await loadPushSubscriptionService()
            expect(await pushSubscriptionService.deleteOwnSubscriptionByEndpoint(uid(7), EP)).toBe(
                true,
            )
            expect(pushSubscriptionRepositoryMock.findByEndpoint).toHaveBeenCalledWith(
                'https://fcm.googleapis.com/fcm/send/a%2Fb',
            )
            expect(pushSubscriptionRepositoryMock.delete).toHaveBeenCalledWith(7n, 3n)
        })

        it("never deletes another user's record with that endpoint", async () => {
            pushSubscriptionRepositoryMock.findByEndpoint.mockResolvedValue({
                id: 3n,
                userId: uid(8),
            })

            const { pushSubscriptionService } = await loadPushSubscriptionService()
            expect(await pushSubscriptionService.deleteOwnSubscriptionByEndpoint(uid(7), EP)).toBe(
                false,
            )
            expect(pushSubscriptionRepositoryMock.delete).not.toHaveBeenCalled()
        })

        it('matches nothing for an endpoint the policy does not allow', async () => {
            const { pushSubscriptionService } = await loadPushSubscriptionService()
            expect(
                await pushSubscriptionService.deleteOwnSubscriptionByEndpoint(
                    uid(7),
                    'https://evil.example/x',
                ),
            ).toBe(false)
            expect(pushSubscriptionRepositoryMock.findByEndpoint).not.toHaveBeenCalled()
        })
    })

    describe('endpoint owned by another user', () => {
        const existing = {
            id: 1n,
            userId: uid(3),
            endpoint: 'https://fcm.googleapis.com/fcm/send/ep',
            p256dhKey: 'key',
            authKey: 'auth',
        }

        it('moves the subscription when p256dh and auth keys match', async () => {
            pushSubscriptionRepositoryMock.findByEndpoint.mockResolvedValue(existing)
            pushSubscriptionRepositoryMock.updateByEndpoint.mockResolvedValue({
                ...existing,
                userId: uid(7),
            })

            const { pushSubscriptionService } = await loadPushSubscriptionService()
            const result = await pushSubscriptionService.createSubscription(
                uid(7),
                {
                    endpoint: existing.endpoint,
                    p256dhKey: 'key',
                    authKey: 'auth',
                },
                'token-7',
            )

            expect(Result.isOk(result)).toBe(true)
            expect(pushSubscriptionRepositoryMock.updateByEndpoint).toHaveBeenCalledWith(
                7n,
                existing.endpoint,
                expect.objectContaining({ p256dhKey: 'key', authKey: 'auth' }),
                TX,
            )
        })

        it.each([
            ['p256dh', { p256dhKey: 'other-key', authKey: 'auth' }],
            ['auth', { p256dhKey: 'key', authKey: 'other-auth' }],
        ])('rejects with conflict when the %s key differs', async (_name, keys) => {
            pushSubscriptionRepositoryMock.findByEndpoint.mockResolvedValue(existing)

            const { pushSubscriptionService } = await loadPushSubscriptionService()
            const result = await pushSubscriptionService.createSubscription(
                uid(7),
                {
                    endpoint: existing.endpoint,
                    ...keys,
                },
                'token-7',
            )

            expect(Result.isError(result)).toBe(true)
            if (Result.isError(result)) {
                expect(result.error).toMatchObject({ _tag: 'Conflict' })
            }
            expect(pushSubscriptionRepositoryMock.updateByEndpoint).not.toHaveBeenCalled()
            expect(pushSubscriptionRepositoryMock.create).not.toHaveBeenCalled()
        })
    })

    it('returns not found for missing subscription statistics', async () => {
        getPushSubscriptionStatisticsMock.mockResolvedValue(undefined)

        const { pushSubscriptionService } = await loadPushSubscriptionService()
        const result = await pushSubscriptionService.getSubscriptionStatistics(
            uid(7),
            1n as PushSubscriptionId,
        )

        expect(Result.isError(result)).toBe(true)
        if (Result.isError(result)) {
            expect(result.error).toEqual({
                _tag: 'NotFound',
                resource: 'Subscription',
                message: 'Subscription not found',
            })
        }
    })

    // feat-104 (R03): the server POSTs to the stored endpoint.
    describe('endpoint policy and subscription limit', () => {
        const payload = (endpoint: string) => ({ endpoint, p256dhKey: 'k', authKey: 'a' })

        it.each([
            'http://fcm.googleapis.com/fcm/send/x',
            'https://10.0.0.5/admin',
            'https://169.254.169.254/latest/meta-data',
            'https://evil.example/fcm.googleapis.com',
        ])('rejects %s before touching the database', async (endpoint) => {
            const { pushSubscriptionService } = await loadPushSubscriptionService()
            const result = await pushSubscriptionService.createSubscription(
                uid(7),
                payload(endpoint),
                'token',
            )

            expect(Result.isError(result) && result.error).toEqual({
                _tag: 'BadRequest',
                message: 'Push endpoint is not allowed',
                reason: 'push_endpoint_not_allowed',
            })
            expect(pushSubscriptionRepositoryMock.findByEndpoint).not.toHaveBeenCalled()
            expect(pushSubscriptionRepositoryMock.create).not.toHaveBeenCalled()
        })

        // feat-208 (L-10)
        it('rejects an endpoint whose canonical form does not fit the column', async () => {
            const { pushSubscriptionService } = await loadPushSubscriptionService()
            const endpoint = `https://fcm.googleapis.com/${'ж'.repeat(400)}`
            expect(endpoint.length).toBeLessThan(500)

            const result = await pushSubscriptionService.createSubscription(
                uid(7),
                payload(endpoint),
                'token',
            )

            expect(Result.isError(result) && result.error).toEqual({
                _tag: 'BadRequest',
                message: 'Push endpoint is too long',
                reason: 'push_endpoint_too_long',
            })
            expect(pushSubscriptionRepositoryMock.findByEndpoint).not.toHaveBeenCalled()
            expect(pushSubscriptionRepositoryMock.create).not.toHaveBeenCalled()
        })

        it('refuses a new subscription once the user has the maximum', async () => {
            pushSubscriptionRepositoryMock.findByEndpoint.mockResolvedValue(undefined)
            pushSubscriptionRepositoryMock.countByUserId.mockResolvedValueOnce(20)
            const { pushSubscriptionService } = await loadPushSubscriptionService()

            const result = await pushSubscriptionService.createSubscription(
                uid(7),
                payload('https://fcm.googleapis.com/fcm/send/new'),
                'token',
            )

            expect(Result.isError(result) && result.error).toEqual({
                _tag: 'Conflict',
                message: 'Too many push subscriptions for this account',
                reason: 'push_subscription_limit',
            })
            expect(pushSubscriptionRepositoryMock.countByUserId).toHaveBeenCalledWith(7n, TX)
            expect(pushSubscriptionRepositoryMock.create).not.toHaveBeenCalled()
        })

        it('counts a subscription moved from another user, not one the user already has', async () => {
            pushSubscriptionRepositoryMock.findByEndpoint.mockResolvedValue({
                id: 1n,
                userId: uid(7),
                endpoint: 'https://fcm.googleapis.com/fcm/send/ep',
                p256dhKey: 'k',
                authKey: 'a',
            })
            pushSubscriptionRepositoryMock.updateByEndpoint.mockResolvedValue({ id: 1n })
            pushSubscriptionRepositoryMock.countByUserId.mockResolvedValue(20)
            const { pushSubscriptionService } = await loadPushSubscriptionService()

            const own = await pushSubscriptionService.createSubscription(
                uid(7),
                payload('https://fcm.googleapis.com/fcm/send/ep'),
                'token',
            )
            expect(Result.isOk(own)).toBe(true)

            const moved = await pushSubscriptionService.createSubscription(
                uid(8),
                payload('https://fcm.googleapis.com/fcm/send/ep'),
                'token',
            )
            expect(Result.isError(moved) && moved.error._tag).toBe('Conflict')
            pushSubscriptionRepositoryMock.countByUserId.mockResolvedValue(0)
        })
    })
})
