import { Redis } from 'ioredis'
import { Result } from 'better-result'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import {
    cleanupTestRedis,
    createTestRedis,
    hasRedis,
} from '../../../test-support/redis-test-client.js'

// feat-232 (Р5): the per-user budget of profile changes in a real Redis. The repositories are
// mocked: the database is not under test here.

const { redis } = vi.hoisted((): { redis: { client: unknown } } => ({ redis: { client: null } }))
vi.mock('#database/redis-rate-limit.js', () => ({
    get default() {
        return redis.client
    },
}))

const userRepositoryMock = {
    findById: vi.fn(),
    updateNameIfSessionToken: vi.fn(),
    shareIfSessionToken: vi.fn(() => Promise.resolve({ name: 'Ann' })),
}
const applyPatch = vi.fn(() =>
    Promise.resolve({
        userId: 7n,
        locale: null,
        timeZone: null,
        theme: 'dark',
        colorTheme: null,
        fontSize: null,
        revision: 1n,
        updatedAt: new Date(),
    }),
)
const withTransaction = vi.fn((work: (tx: unknown) => Promise<unknown>) => work({}))
vi.mock('#app/repositories/index.js', () => ({
    userRepository: userRepositoryMock,
    userPreferencesRepository: { findByUserId: vi.fn(), applyPatch },
    withTransaction,
}))

const client = createTestRedis()
redis.client = client

const { accountService } = await import('./account-service.js')
const { throttlePolicies } = await import('#config/throttle-policies.js')

const stored = () => Promise.resolve(true)
let nextUser = 1000n

beforeAll(async () => {
    if (hasRedis) await client.connect()
})
beforeEach(() => {
    redis.client = client
    vi.clearAllMocks()
})
afterAll(async () => {
    if (!hasRedis) return
    await cleanupTestRedis(client)
    await client.quit()
})

describe.skipIf(!hasRedis)('profile change budget in Redis', () => {
    it('is 30 changes in 10 minutes per user', () => {
        expect(throttlePolicies.accountProfileUser).toMatchObject({
            keyBy: 'user',
            limit: 30,
            windowMs: 600_000,
            onRedisError: 'reject',
        })
    })

    it('30 changes pass, the 31st is a rate limit with no write', async () => {
        const userId = (nextUser += 1n)
        for (let i = 0; i < 30; i += 1) {
            const result = await accountService.updateProfile(
                userId,
                { theme: 'dark' },
                'token',
                stored,
            )
            expect(Result.isOk(result), `change ${String(i + 1)}`).toBe(true)
        }
        expect(withTransaction).toHaveBeenCalledTimes(30)

        const limited = await accountService.updateProfile(
            userId,
            { theme: 'dark' },
            'token',
            stored,
        )

        expect(Result.isError(limited) && limited.error._tag).toBe('RateLimited')
        expect(withTransaction).toHaveBeenCalledTimes(30)
        const ttl = await client.pttl(`auth:throttle:account_profile_user:${String(userId)}`)
        expect(ttl).toBeGreaterThan(600_000 - 5_000)
    })

    it('two sessions of one user share the budget; another user has their own', async () => {
        const userId = (nextUser += 1n)
        for (let i = 0; i < 30; i += 1) {
            const token = i % 2 === 0 ? 'session-a' : 'session-b'
            await accountService.updateProfile(userId, { fontSize: 18 }, token, stored)
        }

        const fromB = await accountService.updateProfile(
            userId,
            { fontSize: 18 },
            'session-b',
            stored,
        )
        const other = await accountService.updateProfile(
            (nextUser += 1n),
            { fontSize: 18 },
            'session-c',
            stored,
        )

        expect(Result.isError(fromB) && fromB.error._tag).toBe('RateLimited')
        expect(Result.isOk(other)).toBe(true)
    })

    it('Redis not answering: the change fails closed (thrown, 503 at the transport), no write', async () => {
        const dead = new Redis('redis://127.0.0.1:1', {
            lazyConnect: true,
            maxRetriesPerRequest: 0,
            enableOfflineQueue: false,
            retryStrategy: () => null,
        })
        redis.client = dead
        try {
            await expect(
                accountService.updateProfile((nextUser += 1n), { theme: 'dark' }, 'token', stored),
            ).rejects.toThrow()
            expect(withTransaction).not.toHaveBeenCalled()
        } finally {
            dead.disconnect()
        }
    })
})
