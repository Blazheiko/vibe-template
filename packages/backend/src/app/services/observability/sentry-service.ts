import * as Sentry from '@sentry/node'
import type { Event, EventHint, NodeOptions, Scope, SeverityLevel } from '@sentry/node'

import sentryConfig from '#config/sentry.js'
import {
    databaseMessageReplacements,
    redactQueryText,
    toSafeError,
} from '#vendor/utils/errors/scrub-error.js'
import { appErrorMessage, type AppError } from '../shared/errors.js'

const MAX_REQUEST_DATA_BYTES = 10 * 1024
const SENSITIVE_KEY_RE = /token|secret|password|cookie|auth|api[_-]?key|bearer/i
const REDACTED_HEADER_KEYS = new Set(['authorization', 'cookie'])
const MAX_SANITIZE_DEPTH = 8

export interface SentryContext {
    requestId?: string | undefined
    userId?: string | undefined
    route?: string | undefined
    method?: string | undefined
    tags?: Record<string, string> | undefined
    extra?: Record<string, unknown> | undefined
}

let initAttempted = false
let active = false

type SentryInitOptions = NodeOptions

function toUserId(value: string | undefined): string | undefined {
    if (value === undefined) {
        return undefined
    }
    return value
}

function applyScopeContext(scope: Scope, ctx: SentryContext): void {
    if (ctx.tags !== undefined) {
        for (const [key, value] of Object.entries(ctx.tags)) {
            scope.setTag(key, value)
        }
    }

    if (ctx.requestId !== undefined) {
        scope.setTag('requestId', ctx.requestId)
    }

    if (ctx.route !== undefined) {
        scope.setTag('route', ctx.route)
    }

    if (ctx.method !== undefined) {
        scope.setTag('method', ctx.method)
    }

    const userId = toUserId(ctx.userId)
    if (userId !== undefined) {
        scope.setUser({ id: userId })
    }

    if (ctx.extra !== undefined) {
        for (const [key, value] of Object.entries(ctx.extra)) {
            scope.setExtra(key, value)
        }
    }
}

function safeStringify(value: unknown): string {
    if (typeof value === 'string') {
        return value
    }

    try {
        return JSON.stringify(value)
    } catch {
        return String(value)
    }
}

function truncateUtf8(value: string, maxBytes: number): string {
    const buffer = Buffer.from(value, 'utf8')
    if (buffer.byteLength <= maxBytes) {
        return value
    }

    return buffer.subarray(0, maxBytes).toString('utf8')
}

function sanitizeRecord(record: Record<string, unknown>): void {
    for (const key of Object.keys(record)) {
        if (SENSITIVE_KEY_RE.test(key)) {
            Reflect.deleteProperty(record, key)
        }
    }
}

// Values Sentry serializes by their own rules (a date as a string, a buffer as bytes): kept as they are.
const isOpaque = (value: object): boolean =>
    value instanceof Date ||
    value instanceof RegExp ||
    value instanceof Map ||
    value instanceof Set ||
    value instanceof Promise ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value)

// Nested values too: drops sensitive keys at every level, the params of anything that looks like a
// query (`query` string + `params`), and the params a query-error message quotes.
// feat-126: a COPY. The objects come from the caller (setExtra, captureException's `extra`, a
// context); deleting their keys here changed the caller's data under its feet. Errors inside are
// replaced by their scrubbed copies (toSafeError) as well.
function sanitizeDeep(value: unknown, depth = 0): unknown {
    if (typeof value === 'string') return redactQueryText(value)
    if (value === null || typeof value !== 'object' || depth >= MAX_SANITIZE_DEPTH) return value
    if (value instanceof Error) {
        // feat-137 (L11): the safe copy keeps the error's own fields; sensitive ones go, and the
        // rest are sanitized like any value. The copy is ours, the caller's error is untouched.
        const safe = toSafeError(value) as Error & Record<string, unknown>
        for (const key of Object.keys(safe)) {
            if (SENSITIVE_KEY_RE.test(key)) Reflect.deleteProperty(safe, key)
            else safe[key] = sanitizeDeep(safe[key], depth + 1)
        }
        return safe
    }

    if (Array.isArray(value)) {
        return value.map((item: unknown) => sanitizeDeep(item, depth + 1))
    }
    if (isOpaque(value)) return value
    // feat-137 (L10): Sentry serializes a value with toJSON (URL, Decimal, a Luxon date) as what
    // toJSON returns; its own fields are often none, so read that way it was sent as `{}`.
    const toJSON = (value as { toJSON?: unknown }).toJSON
    if (typeof toJSON === 'function') {
        try {
            return sanitizeDeep((toJSON as () => unknown).call(value), depth + 1)
        } catch {
            return '[toJSON failed]'
        }
    }

    // feat-127: a class instance too. The processor runs before Sentry normalizes the event into
    // plain data, so an instance passed through unsanitized kept its password/token fields; it is
    // sanitized as the plain object of its own enumerable fields, which is what Sentry sends.
    const record: Record<string, unknown> = { ...(value as Record<string, unknown>) }
    sanitizeRecord(record)
    if (typeof record['query'] === 'string' && 'params' in record) {
        Reflect.deleteProperty(record, 'params')
        Reflect.deleteProperty(record, 'query')
    }
    for (const key of Object.keys(record)) {
        record[key] = sanitizeDeep(record[key], depth + 1)
    }
    return record
}

// Exception values Sentry built from an original error it captured by itself (an uncaught
// exception or rejection never passes through captureException).
function sanitizeExceptions(event: Event, hint: EventHint | undefined): void {
    const values = event.exception?.values
    if (values === undefined) return

    const replacements = databaseMessageReplacements(hint?.originalException)
    for (const exception of values) {
        if (typeof exception.value !== 'string') continue
        exception.value = redactQueryText(replacements.get(exception.value) ?? exception.value)
    }
}

function sanitizeHeaders(headers: Record<string, unknown>): void {
    for (const key of Object.keys(headers)) {
        if (REDACTED_HEADER_KEYS.has(key.toLowerCase()) || SENSITIVE_KEY_RE.test(key)) {
            Reflect.deleteProperty(headers, key)
        }
    }
}

function sanitizeRequestData(request: Record<string, unknown>): void {
    const statusCodeRaw = request['status_code']
    const statusCode =
        typeof statusCodeRaw === 'number'
            ? statusCodeRaw
            : typeof statusCodeRaw === 'string'
              ? Number(statusCodeRaw)
              : Number.NaN

    if (Number.isFinite(statusCode) && statusCode >= 400) {
        delete request['data']
        return
    }

    const rawData = request['data']
    if (rawData === undefined || rawData === null) {
        return
    }

    if (typeof rawData === 'string') {
        request['data'] = truncateUtf8(rawData, MAX_REQUEST_DATA_BYTES)
        return
    }

    const serialized = safeStringify(rawData)
    if (Buffer.byteLength(serialized, 'utf8') <= MAX_REQUEST_DATA_BYTES) {
        return
    }

    request['data'] = truncateUtf8(serialized, MAX_REQUEST_DATA_BYTES)
}

function sanitizeEvent(event: Event, hint?: EventHint): Event {
    if (event.tags !== undefined) {
        sanitizeRecord(event.tags)
    }

    if (event.extra !== undefined) {
        event.extra = sanitizeDeep(event.extra) as NonNullable<Event['extra']>
    }

    if (event.contexts !== undefined) {
        event.contexts = sanitizeDeep(event.contexts) as NonNullable<Event['contexts']>
    }

    if (typeof event.message === 'string') {
        event.message = redactQueryText(event.message)
    }

    sanitizeExceptions(event, hint)

    if (event.breadcrumbs !== undefined) {
        for (const breadcrumb of event.breadcrumbs) {
            if (typeof breadcrumb.message === 'string') {
                breadcrumb.message = redactQueryText(breadcrumb.message)
            }
            if (breadcrumb.data !== undefined) {
                breadcrumb.data = sanitizeDeep(breadcrumb.data) as typeof breadcrumb.data
            }
        }
    }

    if (event.request !== undefined) {
        const request = event.request as Record<string, unknown>
        const headers = request['headers']
        if (headers !== undefined && headers !== null && typeof headers === 'object') {
            sanitizeHeaders(headers as Record<string, unknown>)
        }

        sanitizeRequestData(request)
    }

    return event
}

function isEnabled(): boolean {
    return active
}

function isAppError(value: unknown): value is AppError {
    return typeof value === 'object' && value !== null && '_tag' in value
}

function normalizeException(value: unknown): Error {
    if (value instanceof Error) {
        return value
    }

    if (isAppError(value)) {
        const message = appErrorMessage(value)
        const error = new Error(message) as Error & {
            cause?: unknown
            resource?: string
            reason?: string
        }
        error.name = `AppError.${value._tag}`
        if (value._tag === 'Internal' && value.cause !== undefined) {
            error.cause = value.cause
        }
        if ('resource' in value && typeof value.resource === 'string') {
            error.resource = value.resource
        }
        if ('reason' in value && typeof value.reason === 'string') {
            error.reason = value.reason
        }
        return error
    }

    if (value !== null && typeof value === 'object') {
        const errorLike = value as { name?: unknown; message?: unknown; stack?: unknown }
        const message = typeof errorLike.message === 'string' ? errorLike.message : 'Unknown error'
        const error = new Error(message)
        if (typeof errorLike.name === 'string') {
            error.name = errorLike.name
        }
        if (typeof errorLike.stack === 'string') {
            error.stack = errorLike.stack
        }
        return error
    }

    return new Error(typeof value === 'string' ? value : 'Unknown error')
}

function withScope<T>(ctx: SentryContext, fn: () => T): T {
    if (!isEnabled()) {
        return fn()
    }

    let result: T | undefined
    Sentry.withScope((scope: Scope) => {
        applyScopeContext(scope, ctx)
        result = fn()
    })
    return result as T
}

function captureException(err: unknown, ctx: SentryContext = {}): void {
    if (!isEnabled()) {
        return
    }

    withScope(ctx, () => {
        Sentry.captureException(toSafeError(normalizeException(err)))
    })
}

function captureMessage(
    message: string,
    level: SeverityLevel = 'error',
    ctx: SentryContext = {},
): void {
    if (!isEnabled()) {
        return
    }

    withScope(ctx, () => {
        Sentry.captureMessage(message, level)
    })
}

function flush(timeoutMs = 2000): Promise<boolean> {
    if (!isEnabled()) {
        return Promise.resolve(true)
    }

    return Sentry.flush(timeoutMs).catch(() => false)
}

function buildInitOptions(): SentryInitOptions {
    // Object.assign with more than four sources is typed as `any`.
    return Object.assign(
        {},
        sentryConfig.dsn === undefined ? {} : { dsn: sentryConfig.dsn },
        sentryConfig.environment === undefined ? {} : { environment: sentryConfig.environment },
        sentryConfig.release === undefined ? {} : { release: sentryConfig.release },
        { tracesSampleRate: sentryConfig.tracesSampleRate },
        // Sentry 11 removed `sendDefaultPii` and collects user info, cookies, bodies,
        // gen-AI prompts/outputs and DB query data by default. Keep the v10
        // `sendDefaultPii: false` behaviour explicitly.
        {
            dataCollection: {
                userInfo: false,
                cookies: false,
                httpBodies: [],
                genAI: { inputs: false, outputs: false },
                databaseQueryData: false,
                queues: false,
                stackFrameVariables: false,
            },
        },
    ) as SentryInitOptions
}

function init(): void {
    if (initAttempted) {
        return
    }

    initAttempted = true

    if (!sentryConfig.enabled || sentryConfig.dsn === undefined) {
        active = false
        return
    }

    try {
        Sentry.init(buildInitOptions())
        Sentry.addEventProcessor((event: Event, hint: EventHint) => sanitizeEvent(event, hint))
        active = true
    } catch (error) {
        active = false
        console.warn('[Sentry] Failed to initialize; continuing without Sentry:', error)
    }
}

export const sentryService = {
    init,
    isEnabled,
    captureException,
    captureMessage,
    withScope,
    flush,
} as const
