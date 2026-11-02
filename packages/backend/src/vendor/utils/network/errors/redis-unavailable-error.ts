import { HttpError } from './http-error.js'

/**
 * The main Redis client could not serve a command: not connected, timed out or
 * the connection dropped mid-command. Answered as 503 without the ioredis text;
 * the Sentry transport skips it (redis-health reports one event per incident).
 */
export class RedisUnavailableError extends HttpError {
    readonly name = 'RedisUnavailableError'
    readonly code = 'service_unavailable'
    readonly statusCode = 503

    constructor(message = 'Redis unavailable', options?: { cause?: unknown }) {
        super(message, options)
    }
    // No overrides: classifyError answers a Redis outage in its own first branch
    // (503, Retry-After, sentrySkip), before the generic HttpError one.
}

// ioredis messages that mean "no answer from the server", not a bug in the
// command: commandTimeout, a dropped connection, a command while not ready with
// the offline queue disabled.
const UNAVAILABLE_MESSAGES = ['Command timed out', 'Connection is closed', "Stream isn't writeable"]
// Socket errors say "this connection failed", not which service it led to: S3,
// PostgreSQL and SMTP raise the same codes. They mean Redis only for an error that
// is known to come from a Redis command.
const SOCKET_ERROR_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE'])

/**
 * True for errors that mean Redis is unreachable, whatever code path they came
 * from: the RedisUnavailableError wrapper of the main client and the signs only
 * ioredis produces (the rate-limit client throws them unwrapped). A bare socket
 * error code is not enough: an unreachable S3 or database would pass as Redis.
 * Reply errors (WRONGTYPE, Lua script errors) and programming errors stay false.
 */
export const isRedisUnavailable = (err: unknown): boolean => {
    if (err instanceof RedisUnavailableError) return true
    if (!(err instanceof Error)) return false
    if (err.name === 'MaxRetriesPerRequestError') return true
    if (err.name === 'ReplyError') return false
    return UNAVAILABLE_MESSAGES.some((text) => err.message.startsWith(text))
}

/**
 * For an error thrown by a Redis command (withRedis): a socket error code also
 * means Redis is unreachable, because the source is known.
 */
export const isRedisCommandUnavailable = (err: unknown): boolean => {
    if (isRedisUnavailable(err)) return true
    if (!(err instanceof Error) || err.name === 'ReplyError') return false
    const code = (err as { code?: unknown }).code
    return typeof code === 'string' && SOCKET_ERROR_CODES.has(code)
}
