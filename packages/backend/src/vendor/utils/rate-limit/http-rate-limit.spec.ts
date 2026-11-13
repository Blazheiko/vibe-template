import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ResponseData, RouteItem } from '#vendor/types/types.js'
import type * as HttpRateLimit from './http-rate-limit.js'

vi.mock('#vendor/utils/logger.js', () => ({
    default: {
        debug: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
    },
}))

vi.mock('#config/rate-limit.js', () => ({
    default: {
        httpGlobal: { windowMs: 60_000, max: 3 },
        wsUpgrade: { windowMs: 60_000, max: 2 },
        configError: null,
    },
}))

const createRoute = (rateLimit?: RouteItem['rateLimit'], method = 'post'): RouteItem =>
    ({
        url: '/login',
        method,
        rateLimit,
        handler: vi.fn(),
    }) as unknown as RouteItem

const createResponseData = (): ResponseData => {
    const headers: { name: string; value: string }[] = []
    return {
        aborted: false,
        payload: null,
        middlewareData: {},
        headers,
        cookies: new Map(),
        status: 200,
        deleteCookie: vi.fn(),
        setCookie: vi.fn(),
        setHeader: (name: string, value: string) => {
            headers.push({ name, value })
        },
    }
}

const headerValues = (responseData: ResponseData, name: string): string[] =>
    responseData.headers
        .filter((header) => header.name.toLowerCase() === name.toLowerCase())
        .map((header) => header.value)

// Same order as server.ts: L1, then the route limit.
const check = (limiter: typeof HttpRateLimit, ip: string, route: RouteItem) => {
    const responseData = createResponseData()
    const passed =
        limiter.checkGlobalRateLimit(ip, responseData) && limiter.default(ip, responseData, route)
    return { passed, responseData }
}

const load = () => import('./http-rate-limit.js')

beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
})

describe('checkRateLimit', () => {
    it('leaves routes without configured limits unrestricted', async () => {
        const checkRateLimit = (await load()).default
        const responseData = createResponseData()

        const allowed = checkRateLimit('127.0.0.1', responseData, createRoute())

        expect(allowed).toBe(true)
        expect(responseData.status).toBe(200)
        expect(responseData.payload).toBeNull()
        expect(responseData.headers).toEqual([])
    })

    it('fails closed when the configured limit cannot be checked', async () => {
        const { rateLimitStore } = await import('./rate-limit-store.js')
        vi.spyOn(rateLimitStore, 'consume').mockImplementationOnce(() => {
            throw new Error('counter unavailable')
        })

        const checkRateLimit = (await load()).default
        const responseData = createResponseData()

        const allowed = checkRateLimit(
            '127.0.0.1',
            responseData,
            createRoute({ windowMs: 60_000, maxRequests: 10 }),
        )

        expect(allowed).toBe(false)
        expect(responseData.status).toBe(503)
        expect(responseData.payload).toMatchObject({
            status: 'error',
            code: 'rate_limit_unavailable',
            reason: 'rate_limit_check_failed',
        })
    })

    it('rejects with 429 and Retry-After once the route limit is used up', async () => {
        const limiter = await load()
        const route = createRoute({ windowMs: 60_000, maxRequests: 1 })
        expect(check(limiter, '10.0.0.1', route).passed).toBe(true)

        const { passed, responseData } = check(limiter, '10.0.0.1', route)
        expect(passed).toBe(false)
        expect(responseData.status).toBe(429)
        expect(headerValues(responseData, 'retry-after')).toEqual(['60'])
        expect(headerValues(responseData, 'x-ratelimit-limit')).toEqual(['1'])
    })
})

// feat-206
describe('per-route key and the log of rejections', () => {
    it('counts GET and POST of one URL apart (L-16)', async () => {
        const limiter = await load()
        const post = createRoute({ windowMs: 60_000, maxRequests: 1 }, 'post')
        const get = createRoute({ windowMs: 60_000, maxRequests: 1 }, 'get')
        const responseData = createResponseData()

        expect(limiter.default('10.0.1.1', responseData, post)).toBe(true)
        // The POST budget is used up; the GET of the same URL has its own.
        expect(limiter.default('10.0.1.1', responseData, get)).toBe(true)
        expect(limiter.default('10.0.1.1', responseData, post)).toBe(false)
        expect(limiter.default('10.0.1.1', responseData, get)).toBe(false)
    })

    it('logs one "Rate limit exceeded" per key and window, then the number left out (L-14)', async () => {
        vi.useFakeTimers()
        try {
            const limiter = await load()
            const { default: logger } = await import('#vendor/utils/logger.js')
            const route = createRoute({ windowMs: 60_000, maxRequests: 1 })
            const responseData = createResponseData()

            limiter.default('10.0.1.2', responseData, route)
            for (let index = 0; index < 100; index += 1) {
                expect(limiter.default('10.0.1.2', createResponseData(), route)).toBe(false)
            }
            expect(logger.warn).toHaveBeenCalledTimes(1)
            expect(logger.warn).toHaveBeenCalledWith(
                { key: 'route:10.0.1.2:post:/login', limit: 1, retryAfterMs: 60_000 },
                'Rate limit exceeded',
            )

            // Another address is another key: its own line.
            limiter.default('10.0.1.3', createResponseData(), route)
            limiter.default('10.0.1.3', createResponseData(), route)
            expect(logger.warn).toHaveBeenCalledTimes(2)

            // The next window: one request passes, the second is refused and logged again.
            vi.advanceTimersByTime(60_000)
            limiter.default('10.0.1.2', createResponseData(), route)
            limiter.default('10.0.1.2', createResponseData(), route)
            expect(logger.warn).toHaveBeenCalledTimes(3)
            expect(logger.warn).toHaveBeenLastCalledWith(
                expect.objectContaining({ key: 'route:10.0.1.2:post:/login', suppressed: 99 }),
                'Rate limit exceeded',
            )
        } finally {
            vi.useRealTimers()
        }
    })
})

describe('checkGlobalRateLimit (L1)', () => {
    it('limits routes that have no own rate limit', async () => {
        const limiter = await load()
        const route = createRoute()
        for (let i = 0; i < 3; i++) {
            expect(check(limiter, '10.0.0.2', route).passed).toBe(true)
        }
        const { passed, responseData } = check(limiter, '10.0.0.2', route)
        expect(passed).toBe(false)
        expect(responseData.status).toBe(429)
        expect(check(limiter, '10.0.0.3', route).passed).toBe(true)
    })

    it('fires before the route limit and describes itself on 429', async () => {
        const limiter = await load()
        const route = createRoute({ windowMs: 60_000, maxRequests: 100 })
        for (let i = 0; i < 3; i++) check(limiter, '10.0.0.4', route)

        const { passed, responseData } = check(limiter, '10.0.0.4', route)
        expect(passed).toBe(false)
        expect(headerValues(responseData, 'x-ratelimit-limit')).toEqual(['3'])
        expect(headerValues(responseData, 'x-ratelimit-remaining')).toEqual(['0'])
        expect(headerValues(responseData, 'retry-after')).toHaveLength(1)
    })

    it("adds no headers on success, so only the route limit's set is sent", async () => {
        const limiter = await load()
        const { passed, responseData } = check(
            limiter,
            '10.0.0.5',
            createRoute({ windowMs: 60_000, maxRequests: 100 }),
        )
        expect(passed).toBe(true)
        for (const name of ['x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset']) {
            expect(headerValues(responseData, name)).toHaveLength(1)
        }
        expect(headerValues(responseData, 'x-ratelimit-limit')).toEqual(['100'])
    })
})
