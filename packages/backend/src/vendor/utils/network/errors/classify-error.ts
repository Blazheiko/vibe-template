import type { Logger } from 'pino'
import type { ErrorCode, ErrorDetails } from 'shared/errors'
import { HttpError } from './http-error.js'
import { isRedisUnavailable } from './redis-unavailable-error.js'

export interface ClassifiedError {
    status: number
    code: ErrorCode
    message: string
    details?: ErrorDetails
    /** HTTP only. */
    headers: Readonly<Record<string, string>>
    log: {
        level: 'warn' | 'error'
        fields: Record<string, unknown>
        message: string
    }
}

const RETRY_AFTER_SECONDS = '1'
const UNAVAILABLE_MESSAGE = 'Service temporarily unavailable. Try again later.'

/**
 * One classification of a thrown error for both transports; HTTP turns it into a
 * status + JSON body, WS into the feat-048 error envelope. Branches are checked in
 * this order and the first match wins:
 *
 * 1. Redis unavailable — FIRST: RedisUnavailableError is an HttpError too, and the
 *    generic branch would lose sentrySkip, turning every request of an outage into
 *    its own Sentry event (redis-health sends one per incident). Built here, not
 *    from the class, so the main client's wrapper and the rate-limit client's raw
 *    ioredis errors get the same 503 + Retry-After + sentrySkip.
 * 2. HttpError — from its own fields; warn for 4xx, error for 5xx.
 * 3. Anything else — 500 internal_error.
 */
export const classifyError = (
    err: unknown,
    options: { exposeInternalMessage?: boolean } = {},
): ClassifiedError => {
    if (isRedisUnavailable(err)) {
        return {
            status: 503,
            code: 'service_unavailable',
            message: UNAVAILABLE_MESSAGE,
            headers: { 'Retry-After': RETRY_AFTER_SECONDS },
            log: {
                level: 'error',
                fields: { err, sentrySkip: true },
                message: 'Request failed: Redis unavailable',
            },
        }
    }

    if (err instanceof HttpError) {
        const details = err.details()
        return {
            status: err.statusCode,
            code: err.code,
            message: err.publicMessage,
            ...(details !== undefined ? { details } : {}),
            headers: err.headers(),
            log: {
                level: err.statusCode >= 500 ? 'error' : 'warn',
                fields: err.logFields(),
                message: err.logMessage,
            },
        }
    }

    return {
        status: 500,
        code: 'internal_error',
        message: options.exposeInternalMessage === true ? String(err) : 'Internal server error',
        headers: {},
        log: { level: 'error', fields: { err }, message: 'Handle Error' },
    }
}

export const logClassifiedError = (
    logger: Pick<Logger, 'warn' | 'error'>,
    classified: ClassifiedError,
): void => {
    const { level, fields, message } = classified.log
    logger[level](fields, message)
}

/** The error body both transports send (HTTP adds `status: 'error'` around it). */
export const classifiedErrorBody = (
    classified: ClassifiedError,
): { code: ErrorCode; message: string; details?: ErrorDetails } => ({
    code: classified.code,
    message: classified.message,
    ...(classified.details !== undefined ? { details: classified.details } : {}),
})
