import type { Redis } from 'ioredis'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { hasPg } from '../../test-support/pg-test-db.js'
import { createTestRedis, hasRedis, sleep } from '../../test-support/redis-test-client.js'
import type { Outcome } from './job.js'

// feat-222 (scheduler plan, step 7): a shutdown while SQL is still running. The query of replica
// A waits on a table lock longer than the drain (statement_timeout 1000 ms, drain 100 ms), so
// stop() must abandon the lease, not release it: the key lives to its TTL and replica B, which
// competes for the lease on its own, starts only after A's query has ended. B's first SQL step
// checks that itself, in one snapshot of the database.

vi.hoisted(() => {
    process.env['DB_QUERY_TIMEOUT_MS'] = '1000'
})

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
const silent = vi.hoisted(() => {
    const logger = {
        error: () => undefined,
        warn: () => undefined,
        info: () => undefined,
        debug: () => undefined,
        child: (): unknown => logger,
    }
    return logger
})
vi.mock('#logger', () => ({ default: silent }))

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined }

describe.skipIf(!hasPg || !hasRedis)('scheduler shutdown with SQL in flight', async () => {
    const { pool } = await import('#database/db.js')
    const { connectionOptions } = await import('#database/pool-options.js')
    const { default: client, redisHealth } = (await import('#database/redis.js')) as unknown as {
        default: Redis
        redisHealth: { stop(): void }
    }
    const { acquireLease } = await import('#app/services/shared/redis-lease.js')
    const { defineJob } = await import('./job.js')
    const { jobLeaseKey, leaseForJob, withJobLease } = await import('./job-lease.js')
    const { createScheduler } = await import('./scheduler.js')

    const admin = createTestRedis(PREFIX)
    const STOP_DRAIN_MS = 100
    const lost = (reason: string): Error => new Error(reason)
    let n = 0
    const freshName = (): string => {
        n += 1
        return `sched-shutdown-${String(n)}`
    }

    beforeAll(async () => {
        await admin.connect()
        await client.connect()
        await pool.query('CREATE TABLE IF NOT EXISTS sched_test_target (id int)')
        await pool.query(
            'CREATE TABLE IF NOT EXISTS sched_test_events (job text, event text, a_active boolean)',
        )
    })
    afterAll(async () => {
        await pool.query('DROP TABLE IF EXISTS sched_test_target, sched_test_events')
        redisHealth.stop()
        client.disconnect(false)
        await admin.quit()
        await pool.end()
    })

    const waitFor = async <T>(
        probe: () => Promise<T | undefined>,
        what: string,
        timeoutMs: number,
    ): Promise<T> => {
        const deadline = Date.now() + timeoutMs
        while (Date.now() < deadline) {
            const value = await probe()
            if (value !== undefined) return value
            await sleep(20)
        }
        throw new Error(`timed out waiting for ${what}`)
    }

    async function scenario(name: string, unlockEarly: boolean): Promise<void> {
        // 1. A lock the query of A will wait on.
        const locker = new pg.Client(connectionOptions)
        await locker.connect()
        await locker.query('BEGIN')
        await locker.query('LOCK TABLE sched_test_target IN ACCESS EXCLUSIVE MODE')

        // 2. Replica A: hands its backend pid to the test, then checkpoint() and the query.
        let pidA = 0
        let aError: { code?: string } | undefined
        let aQueryEnded = false
        const spies: {
            abandon?: ReturnType<typeof vi.fn>
            release?: ReturnType<typeof vi.fn>
        } = {}
        const jobA = defineJob({
            name,
            schedule: { every: '1m' },
            timeout: '1m',
            run: async (ctx) => {
                const connection = await pool.connect()
                try {
                    const { rows } = await connection.query<{ pid: number }>(
                        'SELECT pg_backend_pid() AS pid',
                    )
                    pidA = rows[0]?.pid ?? 0
                    ctx.checkpoint()
                    await connection.query('SELECT count(*) FROM sched_test_target')
                } catch (error: unknown) {
                    aError = error as { code?: string }
                } finally {
                    aQueryEnded = true
                    connection.release()
                }
                return { matched: 0, changed: 0 }
            },
        })
        const replicaA = createScheduler({
            jobs: [jobA],
            logger: quiet,
            sentry: { captureException: vi.fn() },
            stopDrainMs: STOP_DRAIN_MS,
            withLease: (options, fn) =>
                withJobLease(options, (scope) => {
                    spies.abandon = vi.spyOn(scope.lease, 'abandon') as never
                    spies.release = vi.spyOn(scope.lease, 'release') as never
                    return fn(scope)
                }),
        })
        const tickA = replicaA.tick()

        // Synchronisation: stop() only once the server shows A's backend waiting on the lock.
        await waitFor(
            async () => {
                if (pidA === 0) return undefined
                const { rows } = await pool.query<{ w: string | null }>(
                    'SELECT wait_event_type AS w FROM pg_stat_activity WHERE pid = $1',
                    [pidA],
                )
                return rows[0]?.w === 'Lock' ? true : undefined
            },
            'the query of A to wait on the lock',
            5_000,
        )

        // Diagnostics only: when the observer saw A's backend stop being active. It is later
        // than the real moment, so it takes no part in the ordering checks.
        let observedEndAt: number | undefined
        const observing = (async (): Promise<void> => {
            const observer = new pg.Client(connectionOptions)
            await observer.connect()
            try {
                for (let i = 0; i < 1000 && observedEndAt === undefined; i += 1) {
                    const { rows } = await observer.query<{ state: string | null }>(
                        'SELECT state FROM pg_stat_activity WHERE pid = $1',
                        [pidA],
                    )
                    if (rows[0]?.state !== 'active') observedEndAt = Date.now()
                    else await sleep(20)
                }
            } finally {
                await observer.end()
            }
        })()

        await replicaA.stop()

        // 3. At the end of the drain: abandoned, not released; the key is there, with less than
        // its full TTL left, and nobody else gets the lease.
        expect(aQueryEnded).toBe(false)
        expect(spies.abandon).toHaveBeenCalledTimes(1)
        expect(spies.release).not.toHaveBeenCalled()
        const ttlMs = leaseForJob(jobA.timeoutMs).ttlMs
        const pttl = await admin.pttl(jobLeaseKey(name))
        expect(pttl).toBeGreaterThan(0)
        expect(pttl).toBeLessThan(ttlMs)
        expect(await acquireLease(jobLeaseKey(name), leaseForJob(60_000), lost)).toBeNull()

        // 4. Replica B competes for the lease on its own, with a short tick; the test does not
        // tell it when to start.
        const outcomesB: Outcome[] = []
        const jobB = defineJob({
            name,
            schedule: { every: '1m' },
            timeout: '1m',
            run: async (ctx) => {
                // 5. B's first SQL step: whether A's query still runs, and B's mark, in one
                // snapshot. Autocommit, so nothing is rolled back. A's connection went back to
                // the pool, so B may run on that very backend: its own pid is not A's query.
                ctx.checkpoint()
                await pool.query(
                    `INSERT INTO sched_test_events (job, event, a_active)
                     SELECT $1, 'b-first', EXISTS (
                         SELECT 1 FROM pg_stat_activity
                         WHERE pid = $2 AND pid <> pg_backend_pid() AND state = 'active'
                     )`,
                    [name, pidA],
                )
                return { matched: 1, changed: 1 }
            },
        })
        const replicaB = createScheduler({
            jobs: [jobB],
            logger: {
                ...quiet,
                info: (entry: object) => {
                    const outcome = (entry as { outcome?: Outcome }).outcome
                    if (outcome !== undefined) outcomesB.push(outcome)
                },
            },
            sentry: { captureException: vi.fn() },
            tickMs: 200,
        })
        replicaB.start()

        if (unlockEarly) await locker.query('COMMIT')

        // A's query ends (cancelled after 1 s, or completed once unlocked); the wrapper's release
        // after the abandon is a no-op: the key is still there.
        await tickA
        expect(spies.release).toHaveBeenCalledTimes(1)
        expect(await admin.exists(jobLeaseKey(name))).toBe(1)
        if (unlockEarly) {
            expect(aError).toBeUndefined()
        } else {
            // 6. The server cancelled A's query.
            expect(aError?.code).toBe('57014')
        }

        try {
            const row = await waitFor(
                async () => {
                    const { rows } = await pool.query<{ a_active: boolean }>(
                        `SELECT a_active FROM sched_test_events WHERE job = $1 AND event = 'b-first'`,
                        [name],
                    )
                    return rows[0]
                },
                'the first SQL step of B',
                ttlMs + 5_000,
            )
            expect(row.a_active).toBe(false)
            expect(outcomesB).toContain('skipped-locked')
            expect(outcomesB).toContain('ok')
        } finally {
            await replicaB.stop()
            if (!unlockEarly) await locker.query('ROLLBACK')
            await locker.end()
            await observing.catch(() => undefined)
        }
        expect(observedEndAt).toBeDefined()
    }

    it('abandons the lease while the query waits; B starts only after it was cancelled', async () => {
        await scenario(freshName(), false)
    }, 45_000)

    it('the same when the lock goes away and the query of A completes', async () => {
        await scenario(freshName(), true)
    }, 45_000)
})
