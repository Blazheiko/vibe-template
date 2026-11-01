import { Result } from 'better-result'
import type { AppError, AppResult } from './errors.js'
import { internal, serviceUnavailable } from './errors.js'
import { isRedisUnavailable } from '#vendor/utils/network/errors/redis-unavailable-error.js'

/**
 * Redis being down is not a server bug: 503 + Retry-After instead of 500. The main client
 * wraps an outage in RedisUnavailableError; the rate-limit client (a second connection)
 * throws plain ioredis errors, which `isRedisUnavailable` recognises as well.
 */
export function toInternalError(cause: unknown, publicMessage = 'Internal error'): AppError {
    if (isRedisUnavailable(cause)) return serviceUnavailable(cause)
    return internal(cause, publicMessage)
}

export function tryInternal<T>(fn: () => Promise<T>, publicMessage: string): Promise<AppResult<T>> {
    return Result.tryPromise({
        try: fn,
        catch: (cause) => toInternalError(cause, publicMessage),
    })
}
