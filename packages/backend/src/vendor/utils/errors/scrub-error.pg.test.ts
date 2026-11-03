import { eq, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { afterAll, describe, expect, it, vi } from 'vitest'

import { hasPg } from '../../../test-support/pg-test-db.js'

// feat-102 on a real PostgreSQL, through the real logger.
// - The app's db (drizzle 1.0.0-rc.5 without `paramsInErrors`) keeps params out of
//   DrizzleQueryError, but pg's own message can quote a value
//   (`invalid input syntax for type bigint: "..."`), and pino folds the cause message into the
//   record.
// - A client with `paramsInErrors: true` puts the params (email, password hash) into the message.
// Neither reaches the log record or what the logger hands Sentry; db-errors.ts still classifies
// the original error.

const { captureExceptionMock } = vi.hoisted(() => ({ captureExceptionMock: vi.fn() }))
vi.mock('#app/services/observability/sentry-service.js', () => ({
    sentryService: {
        init: vi.fn(),
        isEnabled: vi.fn(() => true),
        captureException: captureExceptionMock,
        captureMessage: vi.fn(),
        withScope: vi.fn((_ctx: unknown, fn: () => unknown) => fn()),
        flush: vi.fn().mockResolvedValue(true),
    },
}))

describe.skipIf(!hasPg)('error scrubbing on PostgreSQL', async () => {
    process.env['APP_ENV'] = 'prod'
    const { db, pool } = await import('#database/db.js')
    const { sessionCheckPool } = await import('#database/session-check-db.js')
    const { users } = await import('#database/schema.js')
    const { isUniqueViolation } = await import('#app/repositories/db-errors.js')
    const { default: logger, __loggerTestHooks } = await import('#vendor/utils/logger.js')

    const run = `${String(Date.now())}-${String(process.pid)}`
    const email = `scrub-${run}@example.test`
    const passwordHash = `hash-${run}-secret`

    afterAll(async () => {
        await db.delete(users).where(eq(users.email, email))
        await pool.end()
        await sessionCheckPool.end()
    })

    async function captureLine(log: (target: typeof logger) => void): Promise<string> {
        const lines: string[] = []
        const stream = __loggerTestHooks.sentryStream
        const write = stream.write.bind(stream)
        const spy = vi.spyOn(stream, 'write').mockImplementation((chunk: string) => {
            lines.push(chunk)
            return write(chunk)
        })
        log(logger)
        await new Promise((resolve) => setTimeout(resolve, 0))
        spy.mockRestore()
        expect(lines).toHaveLength(1)
        return lines[0] ?? ''
    }

    function expectAbsent(text: string, ...values: string[]): void {
        for (const value of values) {
            expect(text).not.toContain(value)
        }
    }

    function sentToSentry(): string {
        return JSON.stringify(captureExceptionMock.mock.calls.at(-1)?.[0])
    }

    it('drops a value pg quotes in its message (the app db)', async () => {
        const quoted = `not-a-number-${run}`
        const failure = await db
            .select()
            .from(users)
            .where(sql`${users.id} = ${quoted}::bigint`)
            .then(
                () => undefined,
                (error: unknown) => error as Error,
            )
        if (failure === undefined) throw new Error('the query did not fail')

        // The app db keeps params out of the drizzle message; pg's cause quotes the value.
        expect(failure.message).not.toContain(quoted)
        expect((failure.cause as Error).message).toContain(quoted)

        const line = await captureLine((target) => {
            target.error({ err: failure }, 'lookup failed')
        })

        expectAbsent(line, quoted)
        expect(line).toContain('code=22P02')
        expectAbsent(sentToSentry(), quoted)
    })

    it('drops the params of a client that puts them into errors', async () => {
        const verbose = drizzle({ client: pool, paramsInErrors: true })
        await db.insert(users).values({ name: 'scrub', email, password: 'first' })

        const failure = await verbose
            .insert(users)
            .values({ name: 'scrub', email, password: passwordHash })
            .then(
                () => undefined,
                (error: unknown) => error as Error,
            )
        if (failure === undefined) throw new Error('the second insert did not fail')

        // The original carries the params: proof the test exercises a real leak.
        expect(failure.message).toContain(passwordHash)
        expect(isUniqueViolation(failure)).toBe(true)

        const line = await captureLine((target) => {
            target.error({ err: failure }, 'register failed')
        })

        expectAbsent(line, passwordHash, email)
        expect(line).toContain('Failed query (params redacted)')
        expect(line).toContain('code=23505')
        expectAbsent(sentToSentry(), passwordHash, email)

        // Logging did not change the error the repositories classify.
        expect(isUniqueViolation(failure)).toBe(true)
        expect(failure.message).toContain(passwordHash)
    })
})
