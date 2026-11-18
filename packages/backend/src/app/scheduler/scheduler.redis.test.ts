import type { Redis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import {
    cleanupTestRedis,
    createTestRedis,
    hasRedis,
    sleep,
} from '../../test-support/redis-test-client.js'
import type { Job, JobContext, Outcome } from './job.js'
import type { SchedulerState } from './scheduler-state.js'

// feat-222 (scheduler plan, step 6): the scheduler core on a real Redis: the real withJobLease
// and the real state store; only the slot clock and the logger are fakes.

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
// Readiness pings the database too; this suite has none. Only the Redis half and the
// independence from the scheduler are under test.
vi.mock('#app/repositories/index.js', () => ({
    healthRepository: { pingDatabase: () => Promise.resolve() },
}))

const { default: client, redisHealth } = (await import('#database/redis.js')) as unknown as {
    default: Redis
    redisHealth: { stop(): void }
}
const { defineJob } = await import('./job.js')
const { jobLeaseKey } = await import('./job-lease.js')
const { createScheduler } = await import('./scheduler.js')
const { redisSchedulerState, stateKey } = await import('./scheduler-state.js')
const { readinessService } = await import('#app/services/core/readiness-service.js')

const admin = createTestRedis(PREFIX)
const MINUTE = 60_000
const T0 = Date.parse('2026-11-18T03:05:00Z')

let n = 0
const freshName = (): string => {
    n += 1
    return `sched-redis-${String(n)}`
}

function replica(jobs: Job[], state: SchedulerState = redisSchedulerState) {
    let now = T0
    const entries: { outcome?: Outcome }[] = []
    const record = vi.fn((entry: object) => {
        entries.push(entry)
    })
    const logger = { info: record, warn: record, error: record }
    const scheduler = createScheduler({
        jobs,
        clock: { now: () => now },
        state,
        logger,
        sentry: { captureException: vi.fn() },
        stopDrainMs: 100,
    })
    return {
        scheduler,
        logger,
        outcomes: (): Outcome[] =>
            entries.map((entry) => entry.outcome).filter((o): o is Outcome => o !== undefined),
        advance: (ms: number): void => {
            now += ms
        },
    }
}

const every1m = (
    name: string,
    run: (ctx: JobContext) => Promise<{ matched: number; changed: number }>,
) => defineJob({ name, schedule: { every: '1m' }, timeout: '1m', run })

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

describe.skipIf(!hasRedis)('scheduler on Redis', () => {
    it('two replicas and one slot give one run', async () => {
        const name = freshName()
        const run = vi.fn(async () => {
            await sleep(100)
            return { matched: 1, changed: 1 }
        })
        const a = replica([every1m(name, run)])
        const b = replica([every1m(name, run)])

        await Promise.all([a.scheduler.tick(), b.scheduler.tick()])
        await Promise.all([a.scheduler.tick(), b.scheduler.tick()])

        expect(run).toHaveBeenCalledTimes(1)
        expect([...a.outcomes(), ...b.outcomes()].filter((o) => o === 'ok')).toHaveLength(1)
        expect(await admin.hget(stateKey(name), 'lastSuccessSlot')).toBe(String(T0))
    })

    // leaseForJob renews every 5 s: the loss is seen within one renewal.
    it('a lease lost during the run gives lease-lost, a throwing checkpoint and no state', async () => {
        const name = freshName()
        let checkpointThrew = false
        const a = replica([
            every1m(name, async (ctx) => {
                await admin.del(jobLeaseKey(name))
                await new Promise<void>((resolve) => {
                    ctx.signal.addEventListener('abort', () => {
                        resolve()
                    })
                })
                try {
                    ctx.checkpoint()
                } catch {
                    checkpointThrew = true
                }
                return { matched: 0, changed: 0 }
            }),
        ])

        await a.scheduler.tick()

        expect(a.outcomes()).toEqual(['lease-lost'])
        expect(checkpointThrew).toBe(true)
        expect(await admin.exists(stateKey(name))).toBe(0)
    }, 15_000)

    it('does not start a job while Redis is unavailable, and does not throw', async () => {
        const name = freshName()
        const run = vi.fn(() => Promise.resolve({ matched: 0, changed: 0 }))
        const a = replica([every1m(name, run)])

        // Writes (the SET NX of the lease) wait past the client's command timeout.
        await admin.call('CLIENT', 'PAUSE', '1500', 'WRITE')
        try {
            await expect(a.scheduler.tick()).resolves.toBeUndefined()
        } finally {
            await sleep(1600)
        }

        expect(run).not.toHaveBeenCalled()
        expect(a.logger.warn).toHaveBeenCalledTimes(1)
    })

    it('a restart after a success does not repeat the slot', async () => {
        const name = freshName()
        const run = vi.fn(() => Promise.resolve({ matched: 0, changed: 0 }))

        await replica([every1m(name, run)]).scheduler.tick()
        await replica([every1m(name, run)]).scheduler.tick()

        expect(run).toHaveBeenCalledTimes(1)
    })

    it('after a failure on replica A, replica B keeps to the shared nextRetryAt', async () => {
        const name = freshName()
        const run = vi.fn(() => Promise.reject(new Error('boom')))
        const a = replica([every1m(name, run)])
        const b = replica([every1m(name, run)])

        await a.scheduler.tick()
        b.advance(30_000)
        await b.scheduler.tick()

        expect(run).toHaveBeenCalledTimes(1)
        expect(a.outcomes()).toEqual(['failed'])
        expect(b.outcomes()).toEqual(['skipped-backoff'])
        expect(Number(await admin.hget(stateKey(name), 'nextRetryAt'))).toBeGreaterThan(T0)
    })

    it('when the success could not be written, the next run repeats the job to the same end', async () => {
        const name = freshName()
        const rows = `${name}:rows`
        await admin.sadd(rows, 'r1', 'r2', 'r3')
        const run = vi.fn(async () => {
            const members = await admin.smembers(rows)
            const changed = members.length === 0 ? 0 : await admin.srem(rows, ...members)
            return { matched: members.length, changed }
        })
        let failWrites = true
        const flaky: SchedulerState = {
            ...redisSchedulerState,
            recordSuccess: (...args) =>
                failWrites
                    ? Promise.reject(new Error('Connection is closed'))
                    : redisSchedulerState.recordSuccess(...args),
        }
        const a = replica([every1m(name, run)], flaky)

        await a.scheduler.tick()
        expect(await admin.exists(stateKey(name))).toBe(0)
        expect(await admin.scard(rows)).toBe(0)

        failWrites = false
        a.advance(MINUTE + 1)
        await a.scheduler.tick()

        expect(run).toHaveBeenCalledTimes(2)
        expect(await admin.scard(rows)).toBe(0)
        expect(await admin.hget(stateKey(name), 'lastOutcome')).toBe('ok')
    })

    it('job:run and the scheduled run compete for one lease: the second is busy', async () => {
        const name = freshName()
        let started: () => void = () => undefined
        const running = new Promise<void>((resolve) => (started = resolve))
        let finish: () => void = () => undefined
        const gate = new Promise<void>((resolve) => (finish = resolve))
        const job = every1m(name, async () => {
            started()
            await gate
            return { matched: 0, changed: 0 }
        })
        const scheduled = replica([job])
        const manual = replica([job])

        const tick = scheduled.scheduler.tick()
        await running
        const result = await manual.scheduler.runOnce(name)
        finish()
        await tick

        expect(result.outcome).toBe('skipped-locked')
        expect(scheduled.outcomes()).toEqual(['ok'])
    })

    it('readiness does not depend on the scheduler: ready after a failed job and a busy lease', async () => {
        const name = freshName()
        const a = replica([every1m(name, () => Promise.reject(new Error('boom')))])
        await a.scheduler.tick()
        await admin.set(jobLeaseKey(name), 'someone-else', 'PX', 5_000)
        a.advance(10 * MINUTE)
        await a.scheduler.tick()

        expect(a.outcomes()).toEqual(['failed', 'skipped-locked'])
        expect(await readinessService.check()).toEqual({ ready: true })
    })
})
