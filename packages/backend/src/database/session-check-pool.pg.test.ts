import { createServer, connect, type Server, type Socket } from 'node:net'

import { eq } from 'drizzle-orm'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { hasPg } from '../test-support/pg-test-db.js'

// ADR 0002: the users.session_token lookup must not just stop being waited for, it
// must be cancelled — otherwise a stuck query keeps its pooled connection. Real
// PostgreSQL: a table lock makes the lookup hang the way a stuck database does.

vi.hoisted(() => {
    process.env['SESSION_TOKEN_CHECK_TIMEOUT_MS'] = '300'
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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe.skipIf(!hasPg)('session-check pool on PostgreSQL', async () => {
    const { db, pool } = await import('#database/db.js')
    const { users } = await import('#database/schema.js')
    const { default: databaseConfig } = await import('#config/database.js')
    const { sessionCheckPool, createSessionCheckPool, SESSION_CHECK_POOL_MAX } =
        await import('#database/session-check-db.js')
    const { connectionOptions } = await import('#database/pool-options.js')
    const { checkSessionToken } = await import('#app/services/auth/session-token-check.js')

    const now = Date.now()
    let userId = 0n
    let userToken = ''
    const extraPools: pg.Pool[] = []

    // Statements of the session check that wait on a lock, as the server sees them.
    const blockedLookups = async (): Promise<number> => {
        const { rows } = await pool.query<{ n: number }>(
            `select count(*)::int as n from pg_stat_activity
             where datname = current_database() and state = 'active'
               and wait_event_type = 'Lock' and query like 'select "session_token"%'`,
        )
        return rows[0]?.n ?? 0
    }
    const untilNoBlockedLookup = async (): Promise<number> => {
        for (let i = 0; i < 30; i += 1) {
            const n = await blockedLookups()
            if (n === 0) return 0
            await sleep(50)
        }
        return blockedLookups()
    }

    beforeAll(async () => {
        const [row] = await db
            .insert(users)
            .values({ name: 'check-pool', email: `check-pool-${String(now)}@example.test` })
            .returning()
        if (row === undefined) throw new Error('user not inserted')
        userId = row.id
        userToken = row.sessionToken
    })

    afterAll(async () => {
        await db.delete(users).where(eq(users.id, userId))
        await Promise.allSettled(extraPools.map((extra) => extra.end()))
        await sessionCheckPool.end()
        await pool.end()
    })

    it('answers normally through the dedicated pool', async () => {
        await expect(checkSessionToken(String(userId), userToken)).resolves.toBe('ok')
        await expect(checkSessionToken(String(userId), 'rotated')).resolves.toBe('mismatch')
    })

    describe('a lookup that hangs on a table lock', () => {
        const holdLock = async (): Promise<pg.Client> => {
            const holder = new pg.Client({
                host: databaseConfig.host,
                port: databaseConfig.port,
                user: databaseConfig.user,
                password: databaseConfig.password,
                database: databaseConfig.database,
            })
            await holder.connect()
            await holder.query('begin')
            await holder.query('lock table users in access exclusive mode')
            return holder
        }

        it('is cancelled on the server and the check ends within the deadline', async () => {
            const holder = await holdLock()
            try {
                const started = Date.now()
                const status = await checkSessionToken(String(userId), userToken)
                const elapsed = Date.now() - started

                expect(status).toBe('unavailable')
                expect(elapsed).toBeGreaterThanOrEqual(250)
                expect(elapsed).toBeLessThan(1500)
                // The statement does not outlive the deadline on the server: it was
                // cancelled (statement_timeout), not merely abandoned.
                expect(await untilNoBlockedLookup()).toBe(0)
            } finally {
                await holder.query('rollback')
                await holder.end()
            }
        })

        it('does not use up the pool: many stuck checks, then the pool recovers', async () => {
            const holder = await holdLock()
            try {
                // More concurrent checks than the pool has connections.
                const count = SESSION_CHECK_POOL_MAX * 2
                const results = await Promise.all(
                    Array.from({ length: count }, () =>
                        checkSessionToken(String(userId), userToken),
                    ),
                )
                expect(results).toEqual(Array(count).fill('unavailable'))
                expect(await untilNoBlockedLookup()).toBe(0)
            } finally {
                await holder.query('rollback')
                await holder.end()
            }

            // The lock is gone; the pool serves again without a restart.
            await expect(checkSessionToken(String(userId), userToken)).resolves.toBe('ok')
            expect(sessionCheckPool.totalCount).toBeLessThanOrEqual(SESSION_CHECK_POOL_MAX)
        })

        // Graceful shutdown ends the pools, and pool.end() waits for every checked-out
        // connection: a lookup that never returned would hold the shutdown with it.
        it('does not hold the pool shutdown longer than the deadline', async () => {
            const bounded = createSessionCheckPool({
                connection: connectionOptions,
                timeoutMs: 300,
                max: 2,
            })
            extraPools.push(bounded)
            const holder = await holdLock()
            try {
                const stuck = bounded
                    .query('select "session_token" from "users"')
                    .catch(() => 'cancelled')
                await sleep(100) // the statement is running and waiting on the lock

                const started = Date.now()
                await bounded.end()
                const elapsed = Date.now() - started

                expect(await stuck).toBe('cancelled')
                // Ended by the pool's own timeouts (300 ms from its start), not by the lock,
                // which is released only afterwards.
                expect(elapsed).toBeLessThan(1000)
            } finally {
                await holder.query('rollback')
                await holder.end()
            }
        })

        it('does not touch the main pool: ordinary queries keep their own connections', async () => {
            const holder = await holdLock()
            try {
                const stuck = checkSessionToken(String(userId), userToken)
                // The lock blocks every read of `users`, but the main pool is not the
                // one waiting: a query on another table answers at once.
                const started = Date.now()
                await pool.query('select 1 as one')
                expect(Date.now() - started).toBeLessThan(200)
                await expect(stuck).resolves.toBe('unavailable')
            } finally {
                await holder.query('rollback')
                await holder.end()
            }
        })
    })

    // A server that stops answering altogether (network partition): the query never
    // reaches it, so only the driver's own timeout can end the wait.
    describe('a server that stops answering', () => {
        let proxy: Server
        let stalled = false
        const sockets: Socket[] = []
        let proxyPort = 0

        beforeAll(async () => {
            proxy = createServer((client) => {
                const upstream = connect(databaseConfig.port, databaseConfig.host)
                sockets.push(client, upstream)
                client.on('data', (chunk) => {
                    if (!stalled) upstream.write(chunk)
                })
                upstream.on('data', (chunk) => client.write(chunk))
                client.on('close', () => upstream.destroy())
                upstream.on('close', () => client.destroy())
                client.on('error', () => undefined)
                upstream.on('error', () => undefined)
            })
            await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
            const address = proxy.address()
            proxyPort = typeof address === 'object' && address !== null ? address.port : 0
        })

        afterAll(() => {
            for (const socket of sockets) socket.destroy()
            proxy.close()
        })

        it("frees the pool slot through the driver's query timeout", async () => {
            const proxied = createSessionCheckPool({
                connection: { ...connectionOptions, host: '127.0.0.1', port: proxyPort },
                timeoutMs: 300,
                max: 2,
            })
            extraPools.push(proxied)
            await proxied.query('select 1') // one idle connection
            expect(proxied.totalCount).toBe(1)

            stalled = true
            const started = Date.now()
            await expect(proxied.query('select pg_sleep(5)')).rejects.toThrow(/timeout/i)
            const elapsed = Date.now() - started

            // statement_timeout (300) cannot fire, the server never saw the query; the
            // driver gave up at timeout + 500 ms and the connection was dropped.
            expect(elapsed).toBeGreaterThanOrEqual(700)
            expect(elapsed).toBeLessThan(1500)
            await sleep(50)
            expect(proxied.totalCount).toBe(0)
        })
    })
})
