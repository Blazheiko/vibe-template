import { DrizzleQueryError } from 'drizzle-orm'
import pg from 'pg'
import { stdSerializers } from 'pino'
import { describe, expect, it } from 'vitest'

import {
    databaseMessageReplacements,
    redactQueryText,
    toSafeError,
    toSafeValue,
} from '#vendor/utils/errors/scrub-error.js'

const SECRETS = ['secret-hash', 'tok-123', 'a@b.c', 'Key (email)']

function pgError(): pg.DatabaseError {
    const err = new pg.DatabaseError(
        'duplicate key value violates unique constraint "users_email_unique"',
        0,
        'error',
    )
    err.code = '23505'
    err.constraint = 'users_email_unique'
    err.table = 'users'
    err.severity = 'ERROR'
    err.routine = '_bt_check_unique'
    err.detail = 'Key (email)=(a@b.c) already exists.'
    return err
}

function queryError(): DrizzleQueryError {
    return new DrizzleQueryError(
        'update "users" set "password" = $1, "session_token" = $2 where "email" = $3',
        ['secret-hash', 'tok-123', 'a@b.c'],
        pgError(),
    )
}

// Everything a log line or a Sentry event could carry: own fields, message, stack and the chain.
function dump(value: unknown): string {
    return JSON.stringify(stdSerializers.err(value as Error), (_key, inner: unknown) =>
        inner instanceof Error
            ? Object.assign(
                  { message: inner.message, stack: inner.stack, cause: inner.cause },
                  inner,
              )
            : inner,
    )
}

function expectNoSecrets(text: string): void {
    for (const secret of SECRETS) {
        expect(text).not.toContain(secret)
    }
}

describe('toSafeError', () => {
    it('leaks the params without scrubbing (the reason this exists)', () => {
        expect(dump(queryError())).toContain('secret-hash')
    })

    it('drops the params from message, stack, fields and cause of a query error', () => {
        const safe = toSafeError(queryError())
        const text = dump(safe)

        expectNoSecrets(text)
        expect(safe.message).toBe('Failed query (params redacted)')
        expect(safe.stack?.split('\n')[0]).toBe('DrizzleQueryError: Failed query (params redacted)')
        expect(safe.stack).toMatch(/\n\s+at /)
        expect(safe).toBeInstanceOf(DrizzleQueryError)
    })

    it('keeps the structural fields of a pg cause', () => {
        const safe = toSafeError(queryError())
        const cause = safe.cause as unknown as Record<string, unknown>

        expect(cause).toBeInstanceOf(pg.DatabaseError)
        expect(cause['code']).toBe('23505')
        expect(cause['constraint']).toBe('users_email_unique')
        expect(cause['table']).toBe('users')
        expect(cause['detail']).toBeUndefined()
        expect(cause['message']).toBe(
            'Database error (code=23505 constraint=users_email_unique table=users)',
        )
    })

    it('scrubs a query error wrapped in an application error, and pino keeps the class name', () => {
        class LookupError extends Error {}
        const outer = new LookupError('user lookup failed', { cause: queryError() })
        const serialized = stdSerializers.err(toSafeError(outer))

        expectNoSecrets(JSON.stringify(serialized))
        expect(serialized.type).toBe('LookupError')
        expect(serialized.message).toContain('user lookup failed')
        expect(serialized.message).toContain('Failed query (params redacted)')
        expect(serialized.stack).toContain('caused by:')
    })

    it('drops query fields from any error and scrubs errors held in fields and aggregates', () => {
        const err = Object.assign(new Error('boom'), {
            query: 'select $1',
            params: ['secret-hash'],
            related: queryError(),
            nested: { kept: true },
        })
        const aggregate = new AggregateError([err, queryError()], 'many')

        const safe = toSafeError(aggregate)
        const text = dump(safe)

        expectNoSecrets(text)
        const inner = safe.errors[0] as Record<string, unknown>
        expect(inner['query']).toBeUndefined()
        expect(inner['nested']).toEqual({ kept: true })
        expect((inner['related'] as Error).message).toBe('Failed query (params redacted)')
    })

    it('does not change the original error', () => {
        const err = queryError()
        const before = { message: err.message, stack: err.stack, params: err.params }

        toSafeError(err)

        expect(err.message).toBe(before.message)
        expect(err.stack).toBe(before.stack)
        expect(err.params).toEqual(before.params)
        expect((err.cause as pg.DatabaseError).detail).toContain('a@b.c')
    })

    it('survives a cause cycle and a deep chain', () => {
        const first = new Error('first')
        const second = new Error('second', { cause: first })
        first.cause = second

        const safe = toSafeError(first)
        expect((safe.cause as Error).cause).toBe(safe)

        let deep: Error = queryError()
        for (let index = 0; index < 20; index += 1) {
            deep = new Error(`level ${String(index)}`, { cause: deep })
        }
        expectNoSecrets(dump(toSafeError(deep)))
    })

    it('drops a cause that is not an error', () => {
        const err = new Error('boom', { cause: { rows: ['secret-hash'] } })
        expect(toSafeError(err).cause).toBeUndefined()
    })

    it('returns a value that is not an error as it is', () => {
        const value = { message: 1 }
        expect(toSafeError(value)).toBe(value)
        expect(toSafeError('text')).toBe('text')
    })
})

describe('databaseMessageReplacements', () => {
    it('maps the original message of every database error in the chain', () => {
        const err = new Error('outer', { cause: queryError() })
        const replacements = databaseMessageReplacements(err)

        expect(replacements.size).toBe(2)
        for (const [original, safe] of replacements) {
            expect(original).not.toBe(safe)
            expectNoSecrets(safe)
        }
    })
})

describe('redactQueryText', () => {
    it('cuts a query-error message out of any text', () => {
        expect(redactQueryText('wrapped: Failed query: update x\nparams: secret-hash')).toBe(
            'wrapped: Failed query (params redacted)',
        )
        expect(redactQueryText('plain text')).toBe('plain text')
    })
})

// feat-126: the bypasses the fourth review found.
describe('scrubbing everywhere an error can hide (feat-126)', () => {
    it('keeps no message line that looks like a frame in the rebuilt stack', () => {
        const err = new pg.DatabaseError(
            'syntax error\n    at row (email)=(a@b.c) secret-hash',
            0,
            'error',
        )
        err.code = '42601'
        err.severity = 'ERROR'
        err.routine = 'scanner_yyerror'

        const safe = toSafeError(err)

        expect(safe.stack).not.toContain('secret-hash')
        expect(safe.stack).not.toContain('a@b.c')
        // The real frames stay.
        expect(safe.stack).toMatch(/\n\s+at .*scrub-error\.spec/)
    })

    it('scrubs an error kept in a plain object field of another error', () => {
        const outer = Object.assign(new Error('save failed'), {
            details: { attempt: 2, failures: [queryError()] },
        })

        expect(dump(toSafeError(outer))).not.toMatch(/secret-hash|tok-123/)
        const nested = toSafeValue({ context: { cause: queryError() } })
        expect(dump(nested.context.cause)).not.toMatch(/secret-hash|tok-123/)
    })

    it('does not change the value it was given', () => {
        const original = queryError()
        const record = { context: { cause: original }, list: [original] }

        toSafeValue(record)

        expect(record.context.cause).toBe(original)
        expect(record.list[0]).toBe(original)
        expect(original.message).toContain('secret-hash')
    })
})

describe('only real errors are scrubbed in plain data (feat-127)', () => {
    it('keeps a plain object with a message field as it is', () => {
        const record = {
            message: 'user-facing',
            userId: 5,
            payload: { message: 'hi', where: 'x' },
            error: { code: 'E_VALIDATION', message: 'bad input', params: { field: 'email' } },
        }

        const safe = toSafeValue(record)

        expect(safe).toStrictEqual({
            message: 'user-facing',
            userId: 5,
            payload: { message: 'hi', where: 'x' },
            error: { code: 'E_VALIDATION', message: 'bad input', params: { field: 'email' } },
        })
        // Nothing to replace: no copy at all.
        expect(safe).toBe(record)
    })

    it('scrubs an error-shaped object that has a name, a message and a stack', () => {
        const raw = queryError()
        const shaped = { name: raw.name, message: raw.message, stack: raw.stack, query: raw.query }

        expect(JSON.stringify(toSafeValue({ failure: shaped }))).not.toMatch(/secret-hash|tok-123/)
    })

    it('copies only the path to a replaced error and walks a shared reference once', () => {
        const shared = { failure: queryError() }
        const untouched = { a: 1 }
        const record = { first: shared, second: shared, untouched }

        const safe = toSafeValue(record, () => 'safe')

        expect(safe).not.toBe(record)
        expect(safe.first).toBe(safe.second)
        expect(safe.first.failure).toBe('safe')
        expect(safe.untouched).toBe(untouched)
    })

    it('cuts a cycle and a too-deep subtree instead of passing a raw error on', () => {
        const cyclic: Record<string, unknown> = { failure: queryError() }
        cyclic['self'] = cyclic
        let deep: Record<string, unknown> = { failure: queryError() }
        for (let i = 0; i < 40; i += 1) deep = { next: deep }

        const safeCyclic = toSafeValue(cyclic)
        const safeDeep = toSafeValue(deep)

        expect(safeCyclic['self']).toBe('[Circular]')
        expect(dump(safeCyclic['failure'] as Error)).not.toMatch(/secret-hash|tok-123/)
        expect(JSON.stringify(safeDeep)).toContain('[Truncated]')
        expect(JSON.stringify(safeDeep)).not.toMatch(/secret-hash|tok-123/)
    })
})
