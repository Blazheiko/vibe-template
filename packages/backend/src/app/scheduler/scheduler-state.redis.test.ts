import type { Redis } from 'ioredis'
import { unixMs, ms } from 'shared/brand'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import {
    cleanupTestRedis,
    createTestRedis,
    hasRedis,
} from '../../test-support/redis-test-client.js'

// feat-222 (scheduler plan Р3, Р11): the job state in Redis, written only by the lease owner.

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
const { acquireLease } = await import('#app/services/shared/redis-lease.js')
const { jobLeaseKey } = await import('./job-lease.js')
const { redisSchedulerState: state, stateKey } = await import('./scheduler-state.js')

const admin = createTestRedis(PREFIX)
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const NOW = Date.parse('2026-11-18T03:05:00Z')
const lease = { ttlMs: ms(10_000), renewEveryMs: ms(3_000), maxLifetimeMs: 60_000 }
const lost = (reason: string): Error => new Error(reason)

let n = 0
const freshJob = (): string => {
    n += 1
    return `state-test-${String(n)}`
}
const take = async (job: string) => {
    const held = await acquireLease(jobLeaseKey(job), lease, lost)
    if (held === null) throw new Error('lease busy')
    return held
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

describe.skipIf(!hasRedis)('scheduler state', () => {
    it('reads an empty state for a job that never ran', async () => {
        expect(await state.read(freshJob())).toEqual({ consecutiveFailures: 0 })
    })

    it('records a success: slot, run time, outcome and duration', async () => {
        const job = freshJob()
        const held = await take(job)

        expect(
            await state.recordSuccess(held, job, {
                slot: NOW,
                durationMs: 12.4,
                now: unixMs(NOW + 5),
            }),
        ).toEqual({
            status: 'written',
        })

        expect(await state.read(job)).toEqual({
            lastSuccessSlot: NOW,
            consecutiveFailures: 0,
            lastRunAt: NOW + 5,
            lastOutcome: 'ok',
            lastDurationMs: 12,
        })
        await held.release()
    })

    it('never moves lastSuccessSlot back', async () => {
        const job = freshJob()
        const held = await take(job)

        await state.recordSuccess(held, job, { slot: NOW, durationMs: 1, now: unixMs(NOW) })
        await state.recordSuccess(held, job, { slot: NOW - HOUR, durationMs: 1, now: unixMs(NOW) })

        expect((await state.read(job)).lastSuccessSlot).toBe(NOW)
        await held.release()
    })

    it('backs off 1m, 2m, 4m … up to the maximum, and a success resets it', async () => {
        const job = freshJob()
        const held = await take(job)
        const delays: number[] = []

        for (let i = 0; i < 8; i += 1) {
            const write = await state.recordFailure(held, job, {
                outcome: 'failed',
                durationMs: 3,
                now: unixMs(NOW),
                maxBackoffMs: HOUR,
            })
            expect(write.status).toBe('written')
            if (write.status === 'written') delays.push((write.nextRetryAt - NOW) / MINUTE)
        }

        expect(delays).toEqual([1, 2, 4, 8, 16, 32, 60, 60])
        expect(await state.read(job)).toMatchObject({
            consecutiveFailures: 8,
            nextRetryAt: NOW + HOUR,
            lastOutcome: 'failed',
            lastRunAt: NOW,
        })

        await state.recordSuccess(held, job, { slot: NOW, durationMs: 1, now: unixMs(NOW) })
        const after = await state.read(job)
        expect(after.consecutiveFailures).toBe(0)
        expect(after.nextRetryAt).toBeUndefined()
        await held.release()
    })

    it('keeps lastSuccessSlot on a failure and records a timeout as such', async () => {
        const job = freshJob()
        const held = await take(job)
        await state.recordSuccess(held, job, { slot: NOW, durationMs: 1, now: unixMs(NOW) })

        await state.recordFailure(held, job, {
            outcome: 'timeout',
            durationMs: 9,
            now: unixMs(NOW + MINUTE),
            maxBackoffMs: HOUR,
        })

        expect(await state.read(job)).toMatchObject({
            lastSuccessSlot: NOW,
            lastOutcome: 'timeout',
            lastDurationMs: 9,
        })
        await held.release()
    })

    // Р11: A took the lease, its key vanished, B took a new lease and wrote a success. A's late
    // write must not touch B's state.
    it('refuses a write from a former owner after another replica took the lease', async () => {
        const job = freshJob()
        const a = await take(job)
        await admin.del(jobLeaseKey(job))
        const b = await take(job)
        await state.recordSuccess(b, job, { slot: NOW, durationMs: 1, now: unixMs(NOW) })
        const before = await admin.hgetall(stateKey(job))

        expect(
            await state.recordFailure(a, job, {
                outcome: 'failed',
                durationMs: 1,
                now: unixMs(NOW),
                maxBackoffMs: HOUR,
            }),
        ).toEqual({ status: 'not-owner' })
        expect(
            await state.recordSuccess(a, job, {
                slot: NOW + HOUR,
                durationMs: 1,
                now: unixMs(NOW),
            }),
        ).toEqual({ status: 'not-owner' })

        expect(await admin.hgetall(stateKey(job))).toEqual(before)
        a.abandon()
        await b.release()
    })
})
