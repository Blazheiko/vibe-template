import type { Redis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import {
    cleanupTestRedis,
    createTestRedis,
    hasRedis,
    sleep,
} from '../../test-support/redis-test-client.js'

// feat-222 (scheduler plan Р9): withJobLease on a real Redis.

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
vi.mock('#logger', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

const { default: client, redisHealth } = (await import('#database/redis.js')) as unknown as {
    default: Redis
    redisHealth: { stop(): void }
}
const { acquireLease } = await import('#app/services/shared/redis-lease.js')
const { jobLeaseKey, withJobLease } = await import('./job-lease.js')
const { default: logger } = await import('#logger')

const admin = createTestRedis(PREFIX)
const MINUTE = 60_000
const otherLease = { ttlMs: 60_000, renewEveryMs: 2 ** 30, maxLifetimeMs: 2 ** 30 }
const lost = (reason: string): Error => new Error(reason)

let n = 0
const freshJob = (): string => {
    n += 1
    return `lease-job-${String(n)}`
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

describe.skipIf(!hasRedis)('withJobLease', () => {
    it('holds sched:lease:<job> while fn runs and frees it after', async () => {
        const job = freshJob()
        let heldDuringRun = 0

        await withJobLease({ name: job, timeoutMs: MINUTE }, async () => {
            heldDuringRun = await admin.exists(jobLeaseKey(job))
            return null
        })

        expect(heldDuringRun).toBe(1)
        expect(await admin.exists(jobLeaseKey(job))).toBe(0)
    })

    it('frees the lease when fn throws', async () => {
        const job = freshJob()

        await expect(
            withJobLease({ name: job, timeoutMs: MINUTE }, () => Promise.reject(new Error('boom'))),
        ).rejects.toThrow('boom')

        const next = await acquireLease(jobLeaseKey(job), otherLease, lost)
        expect(next).not.toBeNull()
        await next?.release()
    })

    it('answers busy without calling fn while someone holds the lease', async () => {
        const job = freshJob()
        const holder = await acquireLease(jobLeaseKey(job), otherLease, lost)
        const fn = vi.fn()

        expect(await withJobLease({ name: job, timeoutMs: MINUTE }, fn)).toEqual({ status: 'busy' })
        expect(fn).not.toHaveBeenCalled()
        await holder?.release()
    })

    it('aborts the signal of fn when the caller signal aborts', async () => {
        const job = freshJob()
        const caller = new AbortController()

        const result = await withJobLease(
            { name: job, timeoutMs: MINUTE, signal: caller.signal },
            async ({ signal }) => {
                caller.abort(new Error('SIGINT'))
                await sleep(0)
                return signal.aborted
            },
        )

        expect(result).toMatchObject({ status: 'done', value: true })
    })

    it('keeps the result of fn when the release fails', async () => {
        const job = freshJob()

        const result = await withJobLease({ name: job, timeoutMs: MINUTE }, async ({ lease }) => {
            // Redis "goes away" between fn and the release.
            vi.spyOn(lease, 'release').mockRejectedValueOnce(new Error('Connection is closed'))
            return 'value'
        })

        expect(result).toMatchObject({ status: 'done', value: 'value' })
        expect(vi.mocked(logger).warn).toHaveBeenCalled()
        await admin.del(jobLeaseKey(job))
    })

    it('after abandon() in fn the key lives on to its TTL', async () => {
        const job = freshJob()

        await withJobLease({ name: job, timeoutMs: MINUTE }, async ({ lease }) => {
            lease.abandon()
            return null
        })

        const pttl = await admin.pttl(jobLeaseKey(job))
        expect(pttl).toBeGreaterThan(0)
        expect(await acquireLease(jobLeaseKey(job), otherLease, lost)).toBeNull()
        await admin.del(jobLeaseKey(job))
    })
})
