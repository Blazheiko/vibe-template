import { Result } from 'better-result'
import { afterEach, describe, expect, it, vi } from 'vitest'

const pushSubscriptionRepositoryMock = {
    findByUserIdWithLogs: vi.fn(),
    findByEndpoint: vi.fn(),
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
    (_userId: bigint, _token: string | undefined, work: (tx: unknown) => Promise<unknown>) =>
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
        const result = await pushSubscriptionService.getSubscriptions(7n)

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
            userId: 7n,
            endpoint: 'https://push.example.com/ep',
            p256dhKey: 'old-key',
            authKey: 'old-auth',
        })
        pushSubscriptionRepositoryMock.updateByEndpoint.mockResolvedValue({
            id: 1n,
            endpoint: 'https://push.example.com/ep',
        })

        const { pushSubscriptionService } = await loadPushSubscriptionService()
        const result = await pushSubscriptionService.createSubscription(
            7n,
            {
                endpoint: 'https://push.example.com/ep',
                p256dhKey: 'key',
                authKey: 'auth',
                notificationTypes: ['system'],
            } as any,
            'token-7',
        )

        expect(Result.isOk(result)).toBe(true)
        if (Result.isOk(result)) {
            expect(result.value).toEqual({
                subscription: {
                    serialized: { id: 1n, endpoint: 'https://push.example.com/ep' },
                },
            })
        }
    })

    it('writes inside the session guard, with its transaction', async () => {
        pushSubscriptionRepositoryMock.findByEndpoint.mockResolvedValue(undefined)
        pushSubscriptionRepositoryMock.create.mockResolvedValue({ id: 2n })

        const { pushSubscriptionService } = await loadPushSubscriptionService()
        await pushSubscriptionService.createSubscription(
            7n,
            { endpoint: 'https://push.example.com/new', p256dhKey: 'k', authKey: 'a' },
            'token-7',
        )

        expect(withCurrentSessionMock).toHaveBeenCalledWith(7n, 'token-7', expect.any(Function))
        expect(pushSubscriptionRepositoryMock.findByEndpoint).toHaveBeenCalledWith(
            'https://push.example.com/new',
            TX,
        )
        expect(pushSubscriptionRepositoryMock.create).toHaveBeenCalledWith(
            expect.objectContaining({ userId: 7n }),
            TX,
        )
    })

    it('does not write when the session guard refuses', async () => {
        withCurrentSessionMock.mockResolvedValueOnce(
            Result.err({ _tag: 'Unauthorized', reason: 'session_revoked' }),
        )

        const { pushSubscriptionService } = await loadPushSubscriptionService()
        const created = await pushSubscriptionService.createSubscription(
            7n,
            { endpoint: 'https://push.example.com/new', p256dhKey: 'k', authKey: 'a' },
            'stale-token',
        )
        withCurrentSessionMock.mockResolvedValueOnce(
            Result.err({ _tag: 'Unauthorized', reason: 'session_revoked' }),
        )
        const updated = await pushSubscriptionService.updateSubscription(
            7n,
            1n,
            { isActive: true },
            'stale-token',
        )

        expect(Result.isError(created)).toBe(true)
        expect(Result.isError(updated)).toBe(true)
        expect(pushSubscriptionRepositoryMock.findByEndpoint).not.toHaveBeenCalled()
        expect(pushSubscriptionRepositoryMock.create).not.toHaveBeenCalled()
        expect(pushSubscriptionRepositoryMock.update).not.toHaveBeenCalled()
    })

    describe('endpoint owned by another user', () => {
        const existing = {
            id: 1n,
            userId: 3n,
            endpoint: 'https://push.example.com/ep',
            p256dhKey: 'key',
            authKey: 'auth',
        }

        it('moves the subscription when p256dh and auth keys match', async () => {
            pushSubscriptionRepositoryMock.findByEndpoint.mockResolvedValue(existing)
            pushSubscriptionRepositoryMock.updateByEndpoint.mockResolvedValue({
                ...existing,
                userId: 7n,
            })

            const { pushSubscriptionService } = await loadPushSubscriptionService()
            const result = await pushSubscriptionService.createSubscription(
                7n,
                {
                    endpoint: existing.endpoint,
                    p256dhKey: 'key',
                    authKey: 'auth',
                },
                'token-7',
            )

            expect(Result.isOk(result)).toBe(true)
            expect(pushSubscriptionRepositoryMock.updateByEndpoint).toHaveBeenCalledWith(
                existing.endpoint,
                7n,
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
                7n,
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
        const result = await pushSubscriptionService.getSubscriptionStatistics(7n, 1n)

        expect(Result.isError(result)).toBe(true)
        if (Result.isError(result)) {
            expect(result.error).toEqual({
                _tag: 'NotFound',
                resource: 'Subscription',
                message: 'Subscription not found',
            })
        }
    })
})
