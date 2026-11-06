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

// feat-127: only a real error is scrubbed as one. `isErrorLike` (any object with a string message)
// took `{ code, message }` of an AppError or a plain `payload: { message }` for an error and dropped
// its fields. A cause or an `errors` item of an error is still scrubbed when it is merely error-like.
const isError = (value: object): value is ErrorLike =>
    value instanceof Error ||
    (typeof (value as Error).name === 'string' &&
        typeof (value as Error).message === 'string' &&
        typeof (value as Error).stack === 'string')

interface WalkContext {
    /** Error → its safe copy; shared by the whole walk, so a shared error is copied once. */
    errors: WeakMap<object, unknown>
    /** Plain object or array → its result, so a shared reference is walked once. */
    done: Map<object, unknown>
    /** The objects on the current path: meeting one again is a cycle. */
    active: Set<object>
    /** Applied to the safe copy of every error met in plain data (the logger serializes it). */
    mapError: (safe: ErrorLike) => unknown
}

const CIRCULAR = '[Circular]'
const TRUNCATED = '[Truncated]'
const MAX_VALUE_DEPTH = 32

function copy(err: ErrorLike, depth: number, ctx: WalkContext): ErrorLike {
    const known = ctx.errors.get(err)
    if (known !== undefined) return known as ErrorLike

    // Same prototype, so `instanceof` and `constructor.name` (pino's `type`) stay; no constructor runs.
    const proto = (Object.getPrototypeOf(err) as object | null) ?? Error.prototype
    const safe = Object.create(proto) as ErrorLike
    ctx.errors.set(err, safe)

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
        // feat-126: an error inside a plain value (`details: { err }`) is scrubbed too; it stays an
        // error object here (its own walk, so the logger's mapping does not apply inside an error).
        const fields: WalkContext = {
            ...ctx,
            done: new Map(),
            active: new Set(),
            mapError: (e) => e,
        }
        for (const key of Object.keys(err)) {
            if (BLOCKED_FIELDS.has(key) || key === 'cause' || key === 'errors') continue
            safe[key] = walk(err[key], depth + 1, fields)
        }
    }

    const cause = err.cause
    if (cause !== undefined) {
        // A non-error cause can be anything, including a query result: it is dropped.
        if (isErrorLike(cause)) define(safe, 'cause', scrub(cause, depth + 1, ctx))
    }

    if (Array.isArray(err['errors'])) {
        define(
            safe,
            'errors',
            (err['errors'] as unknown[]).map((inner) =>
                isErrorLike(inner) ? scrub(inner, depth + 1, ctx) : inner,
            ),
        )
    }

    return safe
}

const isWalkableInstance = (value: object): boolean =>
    !(
        value instanceof Date ||
        value instanceof RegExp ||
        value instanceof Map ||
        value instanceof Set ||
        value instanceof Promise ||
        value instanceof ArrayBuffer ||
        ArrayBuffer.isView(value)
    )

const toJSONOf = (value: object): (() => unknown) | undefined => {
    const toJSON = (value as { toJSON?: unknown }).toJSON
    return typeof toJSON === 'function' ? (toJSON as () => unknown) : undefined
}

const TOJSON_FAILED = '[toJSON failed]'

const isPlainObject = (value: object): boolean => {
    const proto = Object.getPrototypeOf(value) as unknown
    return proto === Object.prototype || proto === null
}

// Errors anywhere in plain objects and arrays. Copy-on-write (feat-127): a value without an error,
// a cycle or a cut is returned as it is, so most log records are not copied at all; the caller's
// objects are never changed. A shared reference is walked once and gets one result. A cycle becomes
// `[Circular]` and a subtree deeper than MAX_VALUE_DEPTH `[Truncated]`: an error below either
// would otherwise reach the output raw. Class instances, Buffers and dates are left as they are.
function walk(value: unknown, depth: number, ctx: WalkContext): unknown {
    if (value === null || typeof value !== 'object') return value
    if (isError(value)) {
        const known = ctx.done.get(value)
        if (known !== undefined) return known
        const mapped = ctx.mapError(scrub(value, 0, ctx))
        ctx.done.set(value, mapped)
        return mapped
    }
    const array = Array.isArray(value)
    // feat-137 (L11): a class instance is walked as its own enumerable fields (what JSON.stringify
    // writes), so an error inside it is scrubbed; values serialized by their own rules (dates,
    // buffers, maps) are left as they are. Copy-on-write: without an error inside the
    // instance itself is returned.
    if (!array && !isPlainObject(value) && !isWalkableInstance(value)) return value
    if (ctx.active.has(value)) return CIRCULAR
    if (ctx.done.has(value)) return ctx.done.get(value)
    if (depth > MAX_VALUE_DEPTH) return TRUNCATED

    ctx.active.add(value)
    let result: unknown = value
    // feat-139 (Q1): JSON.stringify writes what toJSON returns, not the fields, so that is what is
    // scrubbed. A toJSON that returns its own object is read as fields below; one that throws
    // would break the whole line and becomes a marker. Nothing to replace: the value stays as is.
    const toJSON = array ? undefined : toJSONOf(value)
    let json: unknown = value
    if (toJSON !== undefined) {
        try {
            json = toJSON.call(value)
        } catch {
            json = TOJSON_FAILED
        }
    }
    if (json !== value) {
        const next = walk(json, depth + 1, ctx)
        if (next !== json || json === TOJSON_FAILED) result = next
    } else if (array) {
        let copied: unknown[] | undefined
        value.forEach((item: unknown, index) => {
            const next = walk(item, depth + 1, ctx)
            if (next !== item && copied === undefined) copied = value.slice(0, index)
            copied?.push(next)
        })
        if (copied !== undefined) result = copied
    } else {
        const entries = Object.entries(value)
        let copied: Record<string, unknown> | undefined
        entries.forEach(([key, item], index) => {
            const next = walk(item, depth + 1, ctx)
            if (next !== item && copied === undefined) {
                copied = Object.fromEntries(entries.slice(0, index))
            }
            if (copied !== undefined) copied[key] = next
        })
        if (copied !== undefined) result = copied
    }
    ctx.active.delete(value)
    ctx.done.set(value, result)
    return result
}

const newContext = (mapError: (safe: ErrorLike) => unknown): WalkContext => ({
    errors: new WeakMap(),
    done: new Map(),
    active: new Set(),
    mapError,
})

/**
 * feat-126: `value` with every error in it (also inside plain objects and arrays) replaced by its
 * safe copy, passed through `mapError` when one is given; the caller's objects are not changed, and
 * a value with nothing to replace is returned as it is. Only a real error counts: an `Error`, or an
 * object with a string `name`, `message` and `stack` (feat-127). For log records and Sentry data,
 * where an error is not always under `err`.
 */
export function toSafeValue<T>(value: T, mapError?: (safe: Error) => unknown): T {
    return walk(value, 0, newContext(mapError ?? ((e): Error => e))) as T
}

function scrub(err: ErrorLike, depth: number, ctx: WalkContext): ErrorLike {
    if (depth > MAX_DEPTH) {
        const stub = new Error('cause chain truncated') as ErrorLike
        return stub
    }
    return copy(err, depth, ctx)
}

/**
 * A copy of `value` that is safe to log or send to Sentry: database errors keep only
 * `SAFE_DB_ERROR_FIELDS` and get a fixed message and a stack rebuilt from it; other errors lose
 * the query fields; `cause` and `AggregateError.errors` are scrubbed the same way (cycles kept as
 * cycles, depth bounded). A value that is not error-like is returned as it is.
 */
export function toSafeError<T>(value: T): T {
    if (!isErrorLike(value)) return value
    return scrub(
        value,
        0,
        newContext((e) => e),
    ) as T
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
