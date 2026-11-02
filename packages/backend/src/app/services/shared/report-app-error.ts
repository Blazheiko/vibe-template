import type { Logger } from 'pino'
import { isRedisUnavailable } from '#vendor/utils/network/errors/redis-unavailable-error.js'
import type { AppError } from './errors.js'
import { appErrorMessage, appErrorStatus } from './errors.js'

const causeOf = (error: AppError): unknown => ('cause' in error ? error.cause : undefined)

/**
 * Logs an AppError that is about to become a 5xx answer. 4xx errors are expected
 * answers and are not logged. The record carries the cause (the original exception)
 * so the error reaches Sentry; a Redis outage is logged with sentrySkip, because
 * redis-health already sends one event per incident and the rate-limit client's raw
 * ioredis errors would slip past the logger's type-based filter.
 */
export function reportAppError(logger: Pick<Logger, 'error'>, error: AppError): void {
    if (appErrorStatus(error) < 500) return
    const cause = causeOf(error)
    logger.error(
        {
            err: cause ?? error,
            appError: error._tag,
            ...(isRedisUnavailable(cause) ? { sentrySkip: true } : {}),
        },
        appErrorMessage(error),
    )
}
