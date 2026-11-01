import { sql } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { hasPg } from '../test-support/pg-test-db.js'

// feat-067 on a real PostgreSQL: the SQL logger follows the environment, and PGSQL_SSL really
// reaches the connection (a plain-text server refuses a TLS client, so the setting is visible).

vi.mock('#logger', () => ({
    default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), child: vi.fn() },
}))

afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    vi.resetModules()
})

async function freshDb(env: Record<string, string>) {
    vi.resetModules()
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value)
    return import('#database/db.js')
}

// drizzle wraps the driver's error ("Failed query: …"); the reason is in the cause chain.
async function reasonOf(promise: PromiseLike<unknown>): Promise<string> {
    try {
        await promise
    } catch (err) {
        const messages: string[] = []
        for (let e: unknown = err; e instanceof Error && messages.length < 5; e = e.cause) {
            messages.push(e.message)
        }
        return messages.join(' <- ')
    }
    return 'no error'
}

describe.skipIf(!hasPg)('the database connection settings on PostgreSQL', () => {
    describe('the SQL logger', () => {
        const statementsLoggedBy = async (env: Record<string, string>): Promise<string[]> => {
            const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
            const { db, pool } = await freshDb(env)
            try {
                await db.execute(sql`select 'sql-logger-probe' as probe`)
            } finally {
                await pool.end()
            }
            return log.mock.calls.map((call) => call.map(String).join(' '))
        }

        it('prints statements in development', async () => {
            const logged = await statementsLoggedBy({
                APP_ENV: 'local',
                APP_IS_PRODUCTION: 'false',
            })

            expect(logged.some((line) => line.includes('sql-logger-probe'))).toBe(true)
        })

        it('prints nothing in a production-like environment', async () => {
            const logged = await statementsLoggedBy({ APP_ENV: 'local', APP_IS_PRODUCTION: 'true' })

            expect(logged.filter((line) => line.includes('sql-logger-probe'))).toEqual([])
            expect(logged.filter((line) => /select|Query:/i.test(line))).toEqual([])
        })

        it('prints nothing for APP_ENV=prod either', async () => {
            const logged = await statementsLoggedBy({ APP_ENV: 'prod' })

            expect(logged.filter((line) => /select|Query:/i.test(line))).toEqual([])
        })
    })

    describe('PGSQL_SSL', () => {
        it('false (the default) connects to the test server', async () => {
            const { db, pool } = await freshDb({ PGSQL_SSL: 'false' })
            try {
                const result = await db.execute<{ one: number }>(sql`select 1 as one`)
                expect(result.rows[0]?.one).toBe(1)
            } finally {
                await pool.end()
            }
        })

        // The test server does not offer TLS (or offers a certificate nobody trusts): a client
        // that asks for verified TLS is refused, which shows the setting reached the pool.
        it('true makes the main pool ask for verified TLS', async () => {
            const { db, pool } = await freshDb({ PGSQL_SSL: 'true' })
            try {
                expect(await reasonOf(db.execute(sql`select 1`))).toMatch(
                    /SSL|TLS|certificate|self-signed/i,
                )
            } finally {
                await pool.end()
            }
        })

        it('true reaches the session-check pool too', async () => {
            vi.resetModules()
            vi.stubEnv('PGSQL_SSL', 'true')
            const { sessionCheckPool } = await import('#database/session-check-db.js')
            try {
                expect(await reasonOf(sessionCheckPool.query('select 1'))).toMatch(
                    /SSL|TLS|certificate|self-signed/i,
                )
            } finally {
                await sessionCheckPool.end()
            }
        })
    })
})
