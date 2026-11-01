import type { Redis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import type { SupportLease } from './support-inflight-lock.js'
import {
    cleanupTestRedis,
    createTestRedis,
    hasRedis,
    sleep,
} from '../../../test-support/redis-test-client.js'

// The support in-flight lock on a real Redis: one holder at a time, and a release that only
// removes the lock it took.

const { PREFIX } = vi.hoisted(() => ({ PREFIX: `test:${crypto.randomUUID()}:` }))

vi.mock('#config/redis.js', async (importActual) => {
    const actual = await importActual<{ default: object }>()
    return { default: { ...actual.default, keyPrefix: PREFIX } }
})
vi.mock('#database/redis.js', async () => {
    const { Redis: Client } = await import('ioredis')
    const { mainRedisOptions } = await import('#database/redis-main-options.js')
    const { createRedisHealth, createWithRedis } = await import('#database/redis-health.js')
    const { host: _host, port: _port, ...contract } = mainRedisOptions
    const client = new Client(process.env['REDIS_TEST_URL'] ?? 'redis://127.0.0.1:6379', {
        ...contract,
        keyPrefix: PREFIX,
        lazyConnect: true,
    })
    const redisHealth = createRedisHealth(client, {
        logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
    })
    return { default: client, redisHealth, withRedis: createWithRedis(client, redisHealth) }
})

const { default: client, redisHealth } = (await import('#database/redis.js')) as unknown as {
    default: Redis
    redisHealth: { stop(): void }
}
const { acquireSupportLock } = await import('./support-inflight-lock.js')
const lockKey = (user: bigint): string => `support:inflight:${String(user)}`

const admin = createTestRedis(PREFIX)
const TTL = 60_000
// A lease that is never renewed in a test's lifetime: stands for a process that died.
const unrenewed = (ttlMs: number): SupportLease => ({
    ttlMs,
    renewEveryMs: 2 ** 30,
    maxLifetimeMs: 2 ** 30,
})
const held = (ttlMs: number): SupportLease => ({
    ttlMs,
    renewEveryMs: Math.floor(ttlMs / 3),
    maxLifetimeMs: 60_000,
})
let nextUser = 1000n
const freshUser = (): bigint => {
    nextUser += 1n
    return nextUser
}

beforeAll(async () => {
    if (!hasRedis) return
    await admin.connect()
    await client.connect()
})
afterAll(async () => {
    if (!hasRedis) return
    await cleanupTestRedis(admin)
    redisHealth.stop()
    client.disconnect(false)
    await admin.quit()
})

describe.skipIf(!hasRedis)('support in-flight lock', () => {
    it('is held by one request at a time and can be taken again after the release', async () => {
        const user = freshUser()

        const first = await acquireSupportLock(user, unrenewed(TTL))
        const second = await acquireSupportLock(user, unrenewed(TTL))

        expect(first).not.toBeNull()
        expect(second).toBeNull()
        expect(await first?.release()).toBe(true)
        expect(await acquireSupportLock(user, unrenewed(TTL))).not.toBeNull()
    })

    it('belongs to one user: another user is not blocked', async () => {
        const first = await acquireSupportLock(freshUser(), unrenewed(TTL))
        const other = await acquireSupportLock(freshUser(), unrenewed(TTL))

        expect(first).not.toBeNull()
        expect(other).not.toBeNull()
    })

    it('expires on its own, so a dead process does not block the user for ever', async () => {
        const user = freshUser()
        expect(await acquireSupportLock(user, unrenewed(100))).not.toBeNull()
        expect(await acquireSupportLock(user, unrenewed(TTL))).toBeNull()

        await sleep(180)

        expect(await acquireSupportLock(user, unrenewed(TTL))).not.toBeNull()
    })

    it('gives the lock to exactly one of 20 concurrent requests', async () => {
        const user = freshUser()

        const results = await Promise.all(
            Array.from({ length: 20 }, () => acquireSupportLock(user, unrenewed(TTL))),
        )

        expect(results.filter((lock) => lock !== null)).toHaveLength(1)
    })

    // The release is what the owner token is for: a plain DEL would remove the lock that a
    // newer request took after this one's lock had expired.
    it('does not remove the lock of a newer request when an expired one is released', async () => {
        const user = freshUser()
        const expired = await acquireSupportLock(user, unrenewed(100))
        await sleep(180)
        const newer = await acquireSupportLock(user, unrenewed(TTL))
        expect(newer).not.toBeNull()

        const releasedByExpired = await expired?.release()

        expect(releasedByExpired).toBe(false)
        // The newer request still holds it: a third one is refused.
        expect(await acquireSupportLock(user, unrenewed(TTL))).toBeNull()
        expect(await newer?.release()).toBe(true)
    })

    it('release is idempotent: the second one finds nothing to remove', async () => {
        const user = freshUser()
        const lock = await acquireSupportLock(user, unrenewed(TTL))

        expect(await lock?.release()).toBe(true)
        expect(await lock?.release()).toBe(false)
    })

    it('sets the expiry it was given', async () => {
        const user = freshUser()
        await acquireSupportLock(user, unrenewed(5_000))

        const ttl = await admin.pttl(`support:inflight:${String(user)}`)

        expect(ttl).toBeGreaterThan(0)
        expect(ttl).toBeLessThanOrEqual(5_000)
    })
    // The lease: a lock held for as long as the answer is being written, not for a guessed
    // time. The database waits of the pipeline are not bounded by the provider timeout, so a
    // fixed TTL let a slow answer outlive its lock while a second one started.
    describe('lease', () => {
        it('is kept alive past its TTL for as long as the holder lives', async () => {
            const user = freshUser()
            const lock = await acquireSupportLock(user, held(300))

            await sleep(1_000)

            expect(lock?.lost.aborted).toBe(false)
            expect(await acquireSupportLock(user, unrenewed(TTL))).toBeNull()
            expect(await lock?.release()).toBe(true)
        })

        it('is lost, and the holder told, when another request holds the key', async () => {
            const user = freshUser()
            const lock = await acquireSupportLock(user, held(300))
            // The key expired and a newer request took it (simulated).
            await admin.set(lockKey(user), 'someone-else')

            await sleep(250)

            expect(lock?.lost.aborted).toBe(true)
            // The foreign key is left alone, by the renewal and by the release.
            expect(await lock?.release()).toBe(false)
            expect(await admin.get(lockKey(user))).toBe('someone-else')
        })

        it('is lost, and the holder told, when the key is gone', async () => {
            const user = freshUser()
            const lock = await acquireSupportLock(user, held(300))
            await admin.del(lockKey(user))

            await sleep(250)

            expect(lock?.lost.aborted).toBe(true)
        })

        it('is abandoned at its maximum lifetime: the holder is told, the renewals stop, the key expires', async () => {
            const user = freshUser()
            const lock = await acquireSupportLock(user, {
                ttlMs: 300,
                renewEveryMs: 100,
                maxLifetimeMs: 450,
            })

            await sleep(250)
            expect(lock?.lost.aborted).toBe(false)
            await sleep(400)
            // Told before the key could be taken by someone else.
            expect(lock?.lost.aborted).toBe(true)
            await sleep(400)

            expect(await acquireSupportLock(user, unrenewed(TTL))).not.toBeNull()
        })

        it('stops renewing once released: the key does not come back', async () => {
            const user = freshUser()
            const lock = await acquireSupportLock(user, held(300))
            expect(await lock?.release()).toBe(true)

            await sleep(500)

            expect(await admin.exists(lockKey(user))).toBe(0)
            expect(lock?.lost.aborted).toBe(false)
        })
    })
})
