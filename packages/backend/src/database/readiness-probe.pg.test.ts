import { createServer, type Server, type Socket } from 'node:net'

import pg from 'pg'
import { afterAll, describe, expect, it, vi } from 'vitest'

import { hasPg } from '../test-support/pg-test-db.js'

// feat-113 (R10) on real PostgreSQL:
// - a main pool with every connection busy does not delay GET /ready (its own connection);
// - a database that accepts connections but does not answer gives "not ready" within the
//   deadline, and parallel probes do not pile up connections (one probe in flight);
// - a probe that timed out does not stay "in progress": once the database answers, the next
//   probe is ready again;
// - the main pool cancels a statement that runs longer than DB_QUERY_TIMEOUT_MS.

vi.hoisted(() => {
    process.env['READINESS_CHECK_TIMEOUT_MS'] = '500'
    process.env['DB_QUERY_TIMEOUT_MS'] = '1500'
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
vi.mock('#database/redis.js', () => ({ default: { ping: () => Promise.resolve('PONG') } }))

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe.skipIf(!hasPg)('readiness probe and main pool timeouts (feat-113)', async () => {
    const { pool } = await import('#database/db.js')
    const {
        default: readinessProbe,
        createReadinessProbe,
        ProbeInFlightError,
    } = await import('#database/readiness-probe.js')
    const { connectionOptions } = await import('#database/pool-options.js')
    const { readinessService } = await import('#app/services/core/readiness-service.js')

    const run = `${String(Date.now())}-${String(process.pid)}`
    const extraProbes: { end(): Promise<void> }[] = []
    let observer: pg.Client | null = null

    // A connection outside every pool under test, to watch pg_stat_activity.
    const observe = async () => {
        if (observer === null) {
            observer = new pg.Client(connectionOptions)
            await observer.connect()
        }
        return observer
    }
    const connectionsOf = async (applicationName: string, state?: string): Promise<number> => {
        const client = await observe()
        const { rows } = await client.query<{ n: number }>(
            `select count(*)::int as n from pg_stat_activity
             where application_name = $1 and ($2::text is null or state = $2)`,
            [applicationName, state ?? null],
        )
        return rows[0]?.n ?? 0
    }

    afterAll(async () => {
        await Promise.allSettled(extraProbes.map((probe) => probe.end()))
        await readinessProbe.end()
        await observer?.end()
        await pool.end()
    })

    it('answers ready within the deadline while every main-pool connection is busy', async () => {
        const busy = Array.from({ length: pool.options.max }, () =>
            pool.query('SELECT pg_sleep(1)'),
        )
        await sleep(100)
        expect(pool.totalCount).toBe(pool.options.max)
        expect(pool.waitingCount).toBe(0)

        const started = Date.now()
        const result = await readinessService.check()
        const elapsed = Date.now() - started

        // Recorded answer: 200 (ready). The main pool being busy is load, not unavailability.
        expect(result).toEqual({ ready: true })
        expect(elapsed).toBeLessThan(500)
        await Promise.all(busy)
    })

    it('a statement that does not answer: not ready within the deadline, one connection', async () => {
        const name = `probe-slow-${run}`
        let slow = true
        const probe = createReadinessProbe({
            connection: connectionOptions,
            timeoutMs: 300,
            statement: () => (slow ? 'SELECT pg_sleep(5)' : 'SELECT 1'),
            applicationName: name,
        })
        extraProbes.push(probe)

        const started = Date.now()
        const first = probe.ping()
        const parallel = Array.from({ length: 5 }, () => probe.ping())
        const outcomes = await Promise.allSettled(parallel)
        for (const outcome of outcomes) {
            expect(outcome.status).toBe('rejected')
            expect((outcome as PromiseRejectedResult).reason).toBeInstanceOf(ProbeInFlightError)
        }
        await sleep(100)
        expect(await connectionsOf(name)).toBe(1)

        await expect(first).rejects.toThrow()
        expect(Date.now() - started).toBeLessThan(1000)

        // The server cancelled the statement: nothing of the probe stays active.
        await sleep(100)
        expect(await connectionsOf(name, 'active')).toBe(0)

        // Recovery: the database answers again, the next probe is ready.
        slow = false
        await expect(probe.ping()).resolves.toBeUndefined()
        expect(await connectionsOf(name)).toBeLessThanOrEqual(1)
    })

    describe('a server that accepts connections and never answers', () => {
        let server: Server | null = null
        const sockets = new Set<Socket>()

        afterAll(async () => {
            for (const socket of sockets) socket.destroy()
            await new Promise<void>((resolve) => {
                if (server === null) {
                    resolve()
                    return
                }
                server.close(() => {
                    resolve()
                })
            })
        })

        it('rejects within the deadline and the next probe is not stuck "in progress"', async () => {
            server = createServer((socket) => {
                sockets.add(socket)
            })
            const silentServer = server
            await new Promise<void>((resolve) => silentServer.listen(0, '127.0.0.1', resolve))
            const address = silentServer.address()
            const port = typeof address === 'object' && address !== null ? address.port : 0

            const probe = createReadinessProbe({
                connection: { ...connectionOptions, host: '127.0.0.1', port, ssl: false },
                timeoutMs: 300,
            })
            extraProbes.push(probe)

            for (let attempt = 0; attempt < 2; attempt += 1) {
                const started = Date.now()
                const outcome = await probe.ping().then(
                    () => 'ready',
                    (error: unknown) => error,
                )
                expect(outcome).toBeInstanceOf(Error)
                expect(outcome).not.toBeInstanceOf(ProbeInFlightError)
                expect(Date.now() - started).toBeLessThan(1000)
            }
        })
    })

    it('the main pool cancels a statement past DB_QUERY_TIMEOUT_MS and keeps the connection usable', async () => {
        const started = Date.now()
        await expect(pool.query('SELECT pg_sleep(5)')).rejects.toMatchObject({ code: '57014' })
        expect(Date.now() - started).toBeLessThan(3000)

        const { rows } = await pool.query<{ one: number }>('SELECT 1 AS one')
        expect(rows[0]?.one).toBe(1)
    })
})
