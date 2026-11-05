import { DrizzleQueryError } from 'drizzle-orm'
import pg from 'pg'

// A failed query can carry user data. pg's own message can quote a value (`invalid input syntax
// for type bigint: "..."`) and its `detail` quotes the row or key; pino folds a cause message into
// the record. A drizzle client created with `paramsInErrors: true` also puts the query params
// (password hash, session token, email) into DrizzleQueryError's `message` and `stack` and keeps
// `query` / `params` as fields; the app's db does not enable it, this guards against it anyway.
// Logs and Sentry get a copy of the error instead (`toSafeError`), with an allowlist of structural
// fields for database errors. The original error is not touched: `db-errors.ts` still reads it.

/** The fields of a database error that describe where it failed, never what was written. */
export const SAFE_DB_ERROR_FIELDS = [
    'code',
    'constraint',
    'table',
    'column',
    'schema',
    'routine',
    'severity',
] as const

/** Never copied from any error: query text, parameters and the values pg quotes. */
const BLOCKED_FIELDS = new Set(['query', 'params', 'detail', 'where', 'internalQuery', 'hint'])

const REDACTED_QUERY_MESSAGE = 'Failed query (params redacted)'
const MAX_DEPTH = 8

type ErrorLike = Error & Record<string, unknown>

const isErrorLike = (value: unknown): value is ErrorLike =>
    typeof value === 'object' && value !== null && typeof (value as Error).message === 'string'

const isQueryError = (err: ErrorLike): boolean =>
    err instanceof DrizzleQueryError ||
    (err.name === 'DrizzleQueryError' && typeof err['query'] === 'string')

// pg-protocol names it 'error'; the structural check also covers a second copy of pg.
const isPgError = (err: ErrorLike): boolean =>
    err instanceof pg.DatabaseError ||
    (typeof err['severity'] === 'string' &&
        typeof err['code'] === 'string' &&
        typeof err['routine'] === 'string')

/** True for an error whose message may quote query data. */
export const isDatabaseError = (value: unknown): boolean =>
    isErrorLike(value) && (isQueryError(value) || isPgError(value))

// pino folds a cause into the outer message and stack only, so the structural fields go into the
// message as well: `Database error (code=23505 constraint=users_email_unique)`.
function safeDbMessage(err: ErrorLike): string {
    if (isQueryError(err)) return REDACTED_QUERY_MESSAGE
    const fields: string[] = []
    for (const field of ['code', 'constraint', 'table', 'column'] as const) {
        const value = err[field]
        if (typeof value === 'string' && value !== '') fields.push(`${field}=${value}`)
    }
    return fields.length === 0 ? 'Database error' : `Database error (${fields.join(' ')})`
}

// The frames only: the header (`Name: message`, several lines for a query error) is rebuilt from
// the safe message. feat-126: the frames are taken AFTER the original header. A message line that
// looks like a frame (`    at …` quoted from the database) is part of the header, not a frame.
function rebuildStack(err: ErrorLike, name: string, message: string): string {
    const stack = typeof err.stack === 'string' ? err.stack : ''
    const originalMessage = typeof err.message === 'string' ? err.message : ''
    const header = `${typeof err.name === 'string' ? err.name : name}: ${originalMessage}`
    const body = stack.startsWith(header)
        ? stack.slice(header.length)
        : // A stack whose header was changed: skip as many lines as the message has.
          stack.split('\n').slice(originalMessage.split('\n').length).join('\n')
    const frames = body.split('\n').filter((line) => /^\s+at /.test(line))
    return [`${name}: ${message}`, ...frames].join('\n')
}

function define(target: object, key: string, value: unknown): void {
    Object.defineProperty(target, key, {
        value,
        writable: true,
        configurable: true,
        enumerable: false,
    })
}

function copy(err: ErrorLike, depth: number, seen: WeakMap<object, unknown>): ErrorLike {
    const known = seen.get(err)
    if (known !== undefined) return known as ErrorLike

    // Same prototype, so `instanceof` and `constructor.name` (pino's `type`) stay; no constructor runs.
    const proto = (Object.getPrototypeOf(err) as object | null) ?? Error.prototype
    const safe = Object.create(proto) as ErrorLike
    seen.set(err, safe)

    const name = typeof err.name === 'string' ? err.name : 'Error'
    if (Object.prototype.hasOwnProperty.call(err, 'name')) define(safe, 'name', name)

    const database = isQueryError(err) || isPgError(err)
    if (database) {
        const message = safeDbMessage(err)
        define(safe, 'message', message)
        define(safe, 'stack', rebuildStack(err, name, message))
        for (const field of SAFE_DB_ERROR_FIELDS) {
            const value = err[field]
            if (typeof value === 'string' && value !== '') safe[field] = value
        }
    } else {
        define(safe, 'message', err.message)
        if (typeof err.stack === 'string') define(safe, 'stack', err.stack)
        for (const key of Object.keys(err)) {
            if (BLOCKED_FIELDS.has(key) || key === 'cause' || key === 'errors') continue
            // feat-126: an error inside a plain value (`details: { err }`) is scrubbed too.
            safe[key] = scrubNested(err[key], depth + 1, seen)
        }
    }

    const cause = err.cause
    if (cause !== undefined) {
        // A non-error cause can be anything, including a query result: it is dropped.
        if (isErrorLike(cause)) define(safe, 'cause', scrub(cause, depth + 1, seen))
    }

    if (Array.isArray(err['errors'])) {
        define(
            safe,
            'errors',
            (err['errors'] as unknown[]).map((inner) =>
                isErrorLike(inner) ? scrub(inner, depth + 1, seen) : inner,
            ),
        )
    }

    return safe
}

const isPlainObject = (value: object): boolean => {
    const proto = Object.getPrototypeOf(value) as unknown
    return proto === Object.prototype || proto === null
}

// Errors anywhere in plain objects and arrays, copied (the caller's value is left alone); other
// values (class instances, Buffers, dates) as they are.
function scrubNested(value: unknown, depth: number, seen: WeakMap<object, unknown>): unknown {
    if (value === null || typeof value !== 'object') return value
    if (isErrorLike(value)) return scrub(value, depth, seen)
    if (depth > MAX_DEPTH) return value
    const known = seen.get(value)
    if (known !== undefined) return known
    if (Array.isArray(value)) {
        const copied: unknown[] = []
        seen.set(value, copied)
        for (const item of value) copied.push(scrubNested(item, depth + 1, seen))
        return copied
    }
    if (!isPlainObject(value)) return value
    const copied: Record<string, unknown> = {}
    seen.set(value, copied)
    for (const [key, item] of Object.entries(value)) {
        copied[key] = scrubNested(item, depth + 1, seen)
    }
    return copied
}

/**
 * feat-126: `value` with every error in it (also inside plain objects and arrays) replaced by its
 * safe copy; the caller's objects are not changed. For log records and Sentry data, where an
 * error is not always under `err`.
 */
export function toSafeValue<T>(value: T): T {
    return scrubNested(value, 0, new WeakMap()) as T
}

function scrub(err: ErrorLike, depth: number, seen: WeakMap<object, unknown>): ErrorLike {
    if (depth > MAX_DEPTH) {
        const stub = new Error('cause chain truncated') as ErrorLike
        return stub
    }
    return copy(err, depth, seen)
}

/**
 * A copy of `value` that is safe to log or send to Sentry: database errors keep only
 * `SAFE_DB_ERROR_FIELDS` and get a fixed message and a stack rebuilt from it; other errors lose
 * the query fields; `cause` and `AggregateError.errors` are scrubbed the same way (cycles kept as
 * cycles, depth bounded). A value that is not error-like is returned as it is.
 */
export function toSafeError<T>(value: T): T {
    if (!isErrorLike(value)) return value
    return scrub(value, 0, new WeakMap()) as T
}

/**
 * The message of every database error in the chain of `value`, mapped to its safe message. Sentry
 * builds exception values from the original error when it captures one by itself (an uncaught
 * exception); the event processor replaces these messages.
 */
export function databaseMessageReplacements(value: unknown): Map<string, string> {
    const replacements = new Map<string, string>()
    const visited = new Set<unknown>()
    const queue: unknown[] = [value]
    while (queue.length > 0 && visited.size < 32) {
        const current = queue.shift()
        if (!isErrorLike(current) || visited.has(current)) continue
        visited.add(current)
        if (isQueryError(current) || isPgError(current)) {
            replacements.set(current.message, safeDbMessage(current))
        }
        queue.push(current.cause)
        if (Array.isArray(current['errors'])) queue.push(...(current['errors'] as unknown[]))
    }
    return replacements
}

/** Cuts the params a query-error message carries, wherever such a message ended up. */
export function redactQueryText(text: string): string {
    return text.includes('Failed query:')
        ? text.replace(/Failed query:[\s\S]*/, REDACTED_QUERY_MESSAGE)
        : text
}
