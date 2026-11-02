import { describe, expect, it, vi } from 'vitest'
import { RedisUnavailableError } from '#vendor/utils/network/errors/redis-unavailable-error.js'
import {
    badRequest,
    conflict,
    forbidden,
    internal,
    notFound,
    rateLimited,
    serviceUnavailable,
    unauthorized,
    upstreamError,
    upstreamTimeout,
    type AppError,
} from './errors.js'
import { reportAppError } from './report-app-error.js'

const report = (error: AppError) => {
    const logger = { error: vi.fn() }
    reportAppError(logger, error)
    return logger.error
}

describe('reportAppError', () => {
    it.each([
        ['BadRequest', badRequest('x')],
        ['Unauthorized', unauthorized()],
        ['Forbidden', forbidden('x')],
        ['NotFound', notFound('User', 'x')],
        ['Conflict', conflict('x')],
        ['RateLimited', rateLimited('x')],
    ])('does not log a 4xx %s', (_tag, error) => {
        expect(report(error)).not.toHaveBeenCalled()
    })

    it('logs an Internal error once with its cause, so Sentry gets the exception', () => {
        const cause = new Error('S3 is down')
        const logError = report(internal(cause, 'Failed to upload avatar'))

        expect(logError).toHaveBeenCalledTimes(1)
        expect(logError).toHaveBeenCalledWith(
            { err: cause, appError: 'Internal' },
            'Failed to upload avatar',
        )
    })

    it('logs the AppError itself when there is no cause', () => {
        const error = internal(undefined, 'Missing rotated CSRF token')
        const logError = report(error)

        expect(logError).toHaveBeenCalledWith(
            { err: error, appError: 'Internal' },
            'Missing rotated CSRF token',
        )
    })

    it.each([
        ['UpstreamError', upstreamError(new Error('LLM 500'))],
        ['UpstreamTimeout', upstreamTimeout(new Error('LLM timeout'))],
    ])('logs a 5xx %s without sentrySkip', (tag, error) => {
        const logError = report(error)

        expect(logError).toHaveBeenCalledTimes(1)
        expect(logError.mock.calls[0]?.[0]).toMatchObject({ appError: tag })
        expect(logError.mock.calls[0]?.[0]).not.toHaveProperty('sentrySkip')
    })

    // One Sentry event per Redis incident comes from redis-health; per-request records
    // stay in stdout. The logger filters only err.type === 'RedisUnavailableError', so a
    // raw ioredis cause (rate-limit client) must be marked here.
    it.each([
        ['RedisUnavailableError (main client)', new RedisUnavailableError()],
        [
            'raw ioredis offline-queue error (rate-limit client)',
            new Error("Stream isn't writeable and enableOfflineQueue options is false"),
        ],
        ['raw ioredis command timeout (rate-limit client)', new Error('Command timed out')],
        [
            'raw ioredis MaxRetriesPerRequestError',
            Object.assign(new Error('Reached the max retries'), {
                name: 'MaxRetriesPerRequestError',
            }),
        ],
    ])('logs a Redis outage (%s) with sentrySkip', (_label, cause) => {
        const logError = report(serviceUnavailable(cause))

        expect(logError).toHaveBeenCalledTimes(1)
        expect(logError.mock.calls[0]?.[0]).toEqual({
            err: cause,
            appError: 'ServiceUnavailable',
            sentrySkip: true,
        })
    })

    // Found in manual verification (feat-086): an unreachable S3 (connect ECONNREFUSED)
    // passed as a Redis outage and would have been hidden from Sentry.
    it('keeps a bare socket error from another service visible to Sentry', () => {
        const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), {
            code: 'ECONNREFUSED',
        })

        const logError = report(serviceUnavailable(cause))

        expect(logError.mock.calls[0]?.[0]).toEqual({ err: cause, appError: 'ServiceUnavailable' })
    })

    it('keeps a non-Redis ServiceUnavailable cause visible to Sentry', () => {
        const cause = new Error('dependency down')
        const logError = report(serviceUnavailable(cause))

        expect(logError.mock.calls[0]?.[0]).toEqual({
            err: cause,
            appError: 'ServiceUnavailable',
        })
    })
})
