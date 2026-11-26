import type { Redis } from 'ioredis'
import { ms } from 'shared/brand'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import {
    cleanupTestRedis,
    createTestRedis,
    hasRedis,
    sleep,
} from '../../../test-support/redis-test-client.js'

// feat-222: abandon() and evalAsOwner() of the lease on a real Redis.

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
const { acquireLease, NOT_OWNER } = await import('./redis-lease.js')

const admin = createTestRedis(PREFIX)
const lost = (reason: string): Error => new Error(reason)
const renewed = (ttlMs: number) => ({
    ttlMs: ms(ttlMs),
    renewEveryMs: ms(Math.floor(ttlMs / 3)),
    maxLifetimeMs: 60_000,
})
let n = 0
const freshKey = (): string => {
    n += 1
    return `lease-test:${String(n)}`
}

// Writes `value` to KEYS[2] only for the owner.
const WRITE_LUA = `redis.call('SET', KEYS[2], ARGV[2]) return 'written'`

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

describe.skipIf(!hasRedis)('lease abandon()', () => {
    it('leaves the key to its remaining TTL: nobody else takes it until it expires', async () => {
        const key = freshKey()
        const held = await acquireLease(key, renewed(600), lost)
        expect(held).not.toBeNull()

        await sleep(250)
        held?.abandon()
        // A release after the abandon is a no-op: the key stays.
        expect(await held?.release()).toBe(false)

        const pttl = await admin.pttl(key)
        expect(pttl).toBeGreaterThan(0)
        expect(pttl).toBeLessThanOrEqual(600)
        expect(await acquireLease(key, renewed(600), lost)).toBeNull()

        await sleep(pttl + 100)

        expect(await admin.exists(key)).toBe(0)
        expect(await acquireLease(key, renewed(600), lost)).not.toBeNull()
    })
})

describe.skipIf(!hasRedis)('lease release()', () => {
    // Two release() calls at once both reach Redis (neither has settled yet); the owner check of
    // RELEASE_LUA makes that safe: one deletes the key, the other finds nothing of its own.
    it('two concurrent releases: one removes the key, the other is refused', async () => {
        const key = freshKey()
        const held = await acquireLease(key, renewed(5_000), lost)

        const results = await Promise.all([held?.release(), held?.release()])

        expect(results.filter((released) => released === true)).toHaveLength(1)
        expect(results.filter((released) => released === false)).toHaveLength(1)
        expect(await admin.exists(key)).toBe(0)
    })

    // The same two calls after the key expired and another holder took it: neither may delete it.
    it('two concurrent releases leave the key of another holder alone', async () => {
        const key = freshKey()
        const held = await acquireLease(key, renewed(5_000), lost)
        await admin.set(key, 'someone-else')

        const results = await Promise.all([held?.release(), held?.release()])

        expect(results).toEqual([false, false])
        expect(await admin.get(key)).toBe('someone-else')
        await admin.del(key)
    })
})

describe.skipIf(!hasRedis)('lease evalAsOwner()', () => {
    it('runs the script for the owner', async () => {
        const key = freshKey()
        const held = await acquireLease(key, renewed(5_000), lost)

        expect(await held?.evalAsOwner(WRITE_LUA, [`${key}:state`], ['mine'])).toBe('written')
        expect(await admin.get(`${key}:state`)).toBe('mine')
    })

    it('writes nothing once the key is gone', async () => {
        const key = freshKey()
        const held = await acquireLease(key, renewed(5_000), lost)
        await admin.del(key)

        expect(await held?.evalAsOwner(WRITE_LUA, [`${key}:state`], ['late'])).toBe(NOT_OWNER)
        expect(await admin.exists(`${key}:state`)).toBe(0)
    })

    it('writes nothing once another holder has taken the key', async () => {
        const key = freshKey()
        const held = await acquireLease(key, renewed(5_000), lost)
        await admin.del(key)
        const newer = await acquireLease(key, renewed(5_000), lost)
        expect(newer).not.toBeNull()
        await newer?.evalAsOwner(WRITE_LUA, [`${key}:state`], ['newer'])

        expect(await held?.evalAsOwner(WRITE_LUA, [`${key}:state`], ['older'])).toBe(NOT_OWNER)
        expect(await admin.get(`${key}:state`)).toBe('newer')
        await newer?.release()
        held?.abandon()
    })
})

// feat-267 (plan Р7): the lease TTL in milliseconds reaches Redis as PX.
describe.skipIf(!hasRedis)('lease TTL', () => {
    it('sets the key for the milliseconds of the lease', async () => {
        const key = freshKey()
        const held = await acquireLease(key, renewed(5_000), lost)
        expect(held).not.toBeNull()

        const pttl = await admin.pttl(key)
        expect(pttl).toBeGreaterThan(4_000)
        expect(pttl).toBeLessThanOrEqual(5_000)
        await held?.release()
    })
})
