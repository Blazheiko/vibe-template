import { type } from '@arktype/type'
import type { BaseType } from '@arktype/type'
import { sentryService } from '#app/services/observability/sentry-service.js'
import type { ResponseValidationMode } from '#config/response-validation.js'
import logger from '#vendor/utils/logger.js'

// Runtime check of a handler result against the route ResponseSchema
// (docs/plan/strip-response-fields-plan.md §4.3). It checks the object the handler
// returned, before JSON serialization:
//  1. `reject` passes and inspectPayload finds nothing → the original object, no copy;
//  2. any error other than an undeclared key, a non-plain object or a non-finite number
//     → 500 in both modes;
//  3. only undeclared keys (incl. keys named like Object.prototype members) → 500 in
//     strict, the stripped copy in log.
// The original object is sent only after a successful `reject`: correct while response
// schemas have no morphs (a guard test in validate-response.spec.ts keeps it so).

export interface ResponseCheckMeta {
    route: string
    transport: 'http' | 'ws' | 'broadcast'
    requestId?: string | undefined
}

/** `payload` is what to send: the original object or its stripped copy; `ok: false` → 500. */
export type ResponseCheckResult = { ok: true; payload: unknown } | { ok: false }

export type ResponseCheck = (payload: unknown, meta: ResponseCheckMeta) => ResponseCheckResult

export interface ResponseCheckOptions {
    mode: ResponseValidationMode
    /** Test hooks. */
    now?: () => number
    /** Replaces `schema.onDeepUndeclaredKey('delete')`, to test a failing strip. */
    strip?: (payload: unknown) => unknown
}

export interface ResponseIssue {
    path: string
    code: string
    expected: string
}

/** One log line and one Sentry event per route and kind within this window. */
export const RESPONSE_VALIDATION_LOG_WINDOW_MS = 60_000

/** Paths kept per log entry; the rest is counted in `truncated`. */
export const RESPONSE_VALIDATION_MAX_ISSUES = 20

/** Log code of an undeclared key, to filter them from schema mismatches. */
export const UNDECLARED_KEY_CODE = 'undeclared_key'

/** A schema error or an issue found by inspectPayload, in the same shape. */
interface Issue {
    propString: string
    code: string
    expected: string
}

// ArkType reports an undeclared key under onDeepUndeclaredKey('reject') as
// `predicate` + `removed`; not a documented contract, so a test pins it.
export const isUndeclaredKey = (error: Pick<Issue, 'code' | 'expected'>): boolean =>
    error.code === 'predicate' && error.expected === 'removed'

type IssueKind = 'mismatch' | 'undeclared'

// ArkType before 2.2.9 read a key named like an Object.prototype member (constructor,
// __proto__, hasOwnProperty, …) through the prototype, so neither reject nor delete saw
// it as undeclared and it reached the client. 2.2.9 reports such keys, but the walk below
// still strips them itself rather than rely on that. No response schema declares one.
const PROTOTYPE_KEYS: ReadonlySet<string> = new Set([
    ...Object.getOwnPropertyNames(Object.prototype),
    '__proto__',
])

/** Log code of an object whose prototype may serialize another structure (toJSON). */
export const UNSAFE_PROTOTYPE_CODE = 'unsafe_prototype'

/** Log code of Infinity / -Infinity: ArkType `number` accepts it, JSON writes null (feat-047). */
export const NON_FINITE_NUMBER_CODE = 'non_finite_number'

const nonFinite = (propString: string): Issue => ({
    propString,
    code: NON_FINITE_NUMBER_CODE,
    expected: 'a finite number',
})

// JSON.stringify serializes exactly what the schema saw only for a plain object, a plain
// array or a plain Date without its own toJSON (enumerable or not: for...in and ArkType
// miss a non-enumerable one). A subclass or an own toJSON may serialize anything.
const hasPlainSerialization = (value: object): boolean => {
    if (Object.hasOwn(value, 'toJSON')) return false
    const proto: unknown = Object.getPrototypeOf(value)
    if (value instanceof Date) return proto === Date.prototype
    if (Array.isArray(value)) return proto === Array.prototype
    return proto === Object.prototype || proto === null
}

interface PayloadInspection {
    /** Own keys named like Object.prototype members, as undeclared-key issues. */
    prototypeKeys: Issue[]
    /** Objects that are not plain, an array or a Date: what JSON gets may differ. */
    unsafe: Issue[]
}

// One walk over what JSON.stringify will visit; ArkType does not check either case.
// Hot path (every response): no allocations on a clean payload, the path string is built
// only for an issue.
const inspectPayload = (payload: unknown): PayloadInspection => {
    const prototypeKeys: Issue[] = []
    const unsafe: Issue[] = []
    const segments: (string | number)[] = []
    const pathOf = (last?: string | number): string => {
        let path = ''
        for (const segment of last === undefined ? segments : [...segments, last]) {
            path +=
                typeof segment === 'number'
                    ? `[${String(segment)}]`
                    : path === ''
                      ? segment
                      : `.${segment}`
        }
        return path
    }
    const walk = (value: object): void => {
        // Checked before the Date and array cases: they have their own hooks too.
        if (!hasPlainSerialization(value)) {
            unsafe.push({
                propString: pathOf(),
                code: UNSAFE_PROTOTYPE_CODE,
                expected: 'a plain object, array or Date',
            })
            return
        }
        if (value instanceof Date) return
        if (Array.isArray(value)) {
            for (let index = 0; index < value.length; index++) {
                const item: unknown = value[index]
                if (typeof item === 'object' && item !== null) {
                    segments.push(index)
                    walk(item)
                    segments.pop()
                } else if (typeof item === 'number' && !Number.isFinite(item)) {
                    unsafe.push(nonFinite(pathOf(index)))
                }
            }
            return
        }
        const record = value as Record<string, unknown>
        for (const key in record) {
            if (!Object.hasOwn(record, key)) continue
            if (PROTOTYPE_KEYS.has(key)) {
                prototypeKeys.push({
                    propString: pathOf(key),
                    code: 'predicate',
                    expected: 'removed',
                })
                continue
            }
            const child = record[key]
            if (typeof child === 'object' && child !== null) {
                segments.push(key)
                walk(child)
                segments.pop()
            } else if (typeof child === 'number' && !Number.isFinite(child)) {
                unsafe.push(nonFinite(pathOf(key)))
            }
        }
    }
    if (typeof payload === 'object' && payload !== null) walk(payload)
    return { prototypeKeys, unsafe }
}

// Copy of `value` without own keys named like Object.prototype members, at any depth.
const omitPrototypeKeys = (value: unknown): unknown => {
    if (typeof value !== 'object' || value === null || value instanceof Date) return value
    if (Array.isArray(value)) return value.map(omitPrototypeKeys)
    const copy: Record<string, unknown> = {}
    for (const key of Object.keys(value)) {
        if (!PROTOTYPE_KEYS.has(key)) {
            copy[key] = omitPrototypeKeys((value as Record<string, unknown>)[key])
        }
    }
    return copy
}

interface RouteLogState {
    lastAt: number
    suppressed: number
}

const logState = new Map<string, RouteLogState>()

export const __resetResponseValidationLog = (): void => {
    logState.clear()
}

// Paths, codes and expected types only: `actual` may carry response values (PII).
const summarize = (errors: readonly Issue[]): { issues: ResponseIssue[]; truncated: number } => ({
    issues: errors.slice(0, RESPONSE_VALIDATION_MAX_ISSUES).map((error) => ({
        path: error.propString === '' ? '(root)' : error.propString,
        code: isUndeclaredKey(error) ? UNDECLARED_KEY_CODE : error.code,
        expected: error.expected,
    })),
    truncated: Math.max(0, errors.length - RESPONSE_VALIDATION_MAX_ISSUES),
})

const report = (
    mode: ResponseValidationMode,
    kind: IssueKind,
    rejected: boolean,
    meta: ResponseCheckMeta,
    errors: readonly Issue[],
    now: number,
): void => {
    // A stripped response (warn) must not hide a 500 of the same route, so each kind
    // has its own window.
    const key = `${meta.transport}:${meta.route}:${kind}`
    const state = logState.get(key)
    if (state !== undefined && now - state.lastAt < RESPONSE_VALIDATION_LOG_WINDOW_MS) {
        state.suppressed += 1
        return
    }
    const suppressed = state?.suppressed ?? 0
    logState.set(key, { lastAt: now, suppressed: 0 })

    const { issues, truncated } = summarize(errors)
    const entry = {
        route: meta.route,
        transport: meta.transport,
        requestId: meta.requestId,
        mode,
        kind,
        rejected,
        issues,
        truncated,
        suppressed,
        // The Sentry event is sent below with its own tag, not from the log stream.
        sentrySkip: true,
    }
    const message =
        kind === 'undeclared'
            ? 'Response has keys undeclared in ResponseSchema'
            : 'Response does not match ResponseSchema'
    if (rejected) logger.error(entry, message)
    else logger.warn(entry, message)

    sentryService.captureMessage(message, rejected ? 'error' : 'warning', {
        requestId: meta.requestId,
        route: meta.route,
        tags: { response_validation: mode, transport: meta.transport, kind },
        extra: { issues, truncated, suppressed },
    })
}

export const createResponseCheck = (
    schema: BaseType | undefined,
    options: ResponseCheckOptions,
): ResponseCheck | null => {
    if (schema === undefined) return null
    const { mode } = options
    const now = options.now ?? Date.now
    const reject = schema.onDeepUndeclaredKey('reject')
    const strip = mode === 'log' ? (options.strip ?? schema.onDeepUndeclaredKey('delete')) : null

    return (payload, meta) => {
        const checked: unknown = reject(payload)
        const schemaErrors = checked instanceof type.errors ? checked : null

        if (schemaErrors !== null && !schemaErrors.every(isUndeclaredKey)) {
            report(mode, 'mismatch', true, meta, schemaErrors, now())
            return { ok: false }
        }
        const { prototypeKeys, unsafe } = inspectPayload(payload)
        if (unsafe.length > 0) {
            report(mode, 'mismatch', true, meta, unsafe, now())
            return { ok: false }
        }
        // ArkType 2.2.9+ reports some of these keys itself: one issue per path.
        const reported = new Set(schemaErrors?.map((error) => error.propString))
        const undeclared: Issue[] = [
            ...(schemaErrors ?? []),
            ...prototypeKeys.filter((issue) => !reported.has(issue.propString)),
        ]
        if (undeclared.length === 0) return { ok: true, payload }

        if (strip === null) {
            report(mode, 'undeclared', true, meta, undeclared, now())
            return { ok: false }
        }
        const stripped: unknown = schemaErrors === null ? payload : strip(payload)
        // Should not fail after a reject with only undeclared keys, but stay fail-closed.
        if (stripped instanceof type.errors) {
            report(mode, 'mismatch', true, meta, stripped, now())
            return { ok: false }
        }
        report(mode, 'undeclared', false, meta, undeclared, now())
        return {
            ok: true,
            payload: prototypeKeys.length > 0 ? omitPrototypeKeys(stripped) : stripped,
        }
    }
}
