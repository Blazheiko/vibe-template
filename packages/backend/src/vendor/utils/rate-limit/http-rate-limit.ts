import type { RateLimit, ResponseData, RouteItem } from '#vendor/types/types.js'
import rateLimitConfig from '#config/rate-limit.js'
import logger from '#vendor/utils/logger.js'
import { createLogThrottle } from './log-throttle.js'
import {
    clientKey,
    rateLimitStore,
    retryAfterSeconds,
    type ConsumeOptions,
    type RateLimitDecision,
} from './rate-limit-store.js'

// feat-206: a client over its limit is refused on every request, and a log line for each
// of them is the flood the limit exists to stop. One line per key and window; the next one
// says how many were left out.
const rejectionLog = createLogThrottle()

function determineRateLimit(route: RouteItem, groupRateLimit?: RateLimit): RateLimit | null {
    // Route limits override group limits
    if (route.rateLimit !== undefined) {
        return route.rateLimit
    }

    if (groupRateLimit !== undefined) {
        return groupRateLimit
    }

    return null
}

const writeRateLimitHeaders = (responseData: ResponseData, decision: RateLimitDecision): void => {
    responseData.setHeader('X-RateLimit-Limit', decision.limit.toString())
    responseData.setHeader(
        'X-RateLimit-Remaining',
        (decision.allowed ? decision.remaining : 0).toString(),
    )
    responseData.setHeader('X-RateLimit-Reset', Math.ceil(decision.resetAt / 1000).toString())
}

const rejectRateLimited = (responseData: ResponseData, retryAfterMs: number): void => {
    const retryAfter = retryAfterSeconds(retryAfterMs)
    responseData.status = 429
    responseData.payload = {
        status: 'error',
        code: 'rate_limited',
        message: 'Too many requests, please try again later.',
        reason: 'rate_limit_exceeded',
        retryAfter,
        details: {
            kind: 'rate_limited',
            retryAfterMs: retryAfter * 1000,
        },
    }
    responseData.setHeader('Retry-After', retryAfter.toString())
}

const rejectUnavailable = (responseData: ResponseData): void => {
    responseData.status = 503
    responseData.payload = {
        status: 'error',
        code: 'rate_limit_unavailable',
        message: 'Request throttling is temporarily unavailable.',
        reason: 'rate_limit_check_failed',
        details: {
            kind: 'rate_limit_unavailable',
        },
    }
}

const consumeOrReject = (
    key: string,
    options: ConsumeOptions,
    responseData: ResponseData,
    headers: 'always' | 'on-reject',
): boolean => {
    try {
        const decision = rateLimitStore.consume(key, options)
        if (headers === 'always' || !decision.allowed) {
            writeRateLimitHeaders(responseData, decision)
        }
        if (!decision.allowed) {
            const suppressed = rejectionLog.shouldLog(key, options.windowMs)
            if (suppressed !== null) {
                logger.warn(
                    {
                        key,
                        limit: decision.limit,
                        retryAfterMs: decision.retryAfterMs,
                        ...(suppressed > 0 && { suppressed }),
                    },
                    'Rate limit exceeded',
                )
            }
            rejectRateLimited(responseData, decision.retryAfterMs)
            return false
        }
        return true
    } catch (err) {
        logger.error({ err }, 'Rate limit check failed')
        rejectUnavailable(responseData)
        return false
    }
}

/**
 * L1: one fixed-window budget per IP for every API request (routes, API 404,
 * preflight). Writes X-RateLimit-* only when it rejects, so a successful
 * response carries only the route limiter's headers.
 */
export function checkGlobalRateLimit(
    ip: string | null | undefined,
    responseData: ResponseData,
): boolean {
    const { windowMs, max } = rateLimitConfig.httpGlobal
    if (max === 0) return true
    return consumeOrReject(
        `http:${clientKey(ip)}`,
        { windowMs, max, algorithm: 'fixed-window' },
        responseData,
        'on-reject',
    )
}

export default function checkRateLimit(
    ip: string | null | undefined,
    responseData: ResponseData,
    route: RouteItem,
    groupRateLimit?: RateLimit,
): boolean {
    const rateLimit = determineRateLimit(route, groupRateLimit)
    if (rateLimit === null) {
        return true
    }

    // feat-206: the method is part of the key. GET and POST of one URL are two routes with
    // two limits; in one bucket the cheap one could use up the budget of the strict one.
    return consumeOrReject(
        `route:${clientKey(ip)}:${route.method}:${route.url}`,
        { windowMs: rateLimit.windowMs, max: rateLimit.maxRequests },
        responseData,
        'always',
    )
}
