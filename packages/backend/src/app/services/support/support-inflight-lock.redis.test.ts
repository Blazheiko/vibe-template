import type { Redis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

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

const admin = createTestRedis(PREFIX)
const TTL = 60_000
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

        const first = await acquireSupportLock(user, TTL)
        const second = await acquireSupportLock(user, TTL)

        expect(first).not.toBeNull()
        expect(second).toBeNull()
        expect(await first?.release()).toBe(true)
        expect(await acquireSupportLock(user, TTL)).not.toBeNull()
    })

    it('belongs to one user: another user is not blocked', async () => {
        const first = await acquireSupportLock(freshUser(), TTL)
        const other = await acquireSupportLock(freshUser(), TTL)

        expect(first).not.toBeNull()
        expect(other).not.toBeNull()
    })

    it('expires on its own, so a dead process does not block the user for ever', async () => {
        const user = freshUser()
        expect(await acquireSupportLock(user, 100)).not.toBeNull()
        expect(await acquireSupportLock(user, TTL)).toBeNull()

        await sleep(180)

        expect(await acquireSupportLock(user, TTL)).not.toBeNull()
    })

    it('gives the lock to exactly one of 20 concurrent requests', async () => {
        const user = freshUser()

        const results = await Promise.all(
            Array.from({ length: 20 }, () => acquireSupportLock(user, TTL)),
        )

        expect(results.filter((lock) => lock !== null)).toHaveLength(1)
    })

    // The release is what the owner token is for: a plain DEL would remove the lock that a
    // newer request took after this one's lock had expired.
    it('does not remove the lock of a newer request when an expired one is released', async () => {
        const user = freshUser()
        const expired = await acquireSupportLock(user, 100)
        await sleep(180)
        const newer = await acquireSupportLock(user, TTL)
        expect(newer).not.toBeNull()

        const releasedByExpired = await expired?.release()

        expect(releasedByExpired).toBe(false)
        // The newer request still holds it: a third one is refused.
        expect(await acquireSupportLock(user, TTL)).toBeNull()
        expect(await newer?.release()).toBe(true)
    })

    it('release is idempotent: the second one finds nothing to remove', async () => {
        const user = freshUser()
        const lock = await acquireSupportLock(user, TTL)

        expect(await lock?.release()).toBe(true)
        expect(await lock?.release()).toBe(false)
    })

    it('sets the expiry it was given', async () => {
        const user = freshUser()
        await acquireSupportLock(user, 5_000)

        const ttl = await admin.pttl(`support:inflight:${String(user)}`)

        expect(ttl).toBeGreaterThan(0)
        expect(ttl).toBeLessThanOrEqual(5_000)
    })
})
