import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { MyWebSocket, RouteItem } from '#vendor/types/types.js'

vi.mock('#vendor/utils/logger.js', () => ({
    default: {
        debug: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
    },
}))

const createRoute = (rateLimit?: RouteItem['rateLimit']): RouteItem =>
    ({
        url: 'message_send',
        method: 'ws',
        rateLimit,
        handler: vi.fn(),
    }) as unknown as RouteItem

const createWs = (ip = '127.0.0.1'): MyWebSocket =>
    ({
        getUserData: () => ({ ip }),
    }) as unknown as MyWebSocket

describe('checkRateLimitWs', () => {
    beforeEach(() => {
        vi.resetModules()
        vi.clearAllMocks()
    })

    it('leaves routes without configured limits unrestricted', async () => {
        const checkRateLimitWs = (await import('./ws-rate-limit.js')).default

        const result = checkRateLimitWs(createWs(), createRoute())

        expect(result).toEqual({ allowed: true })
    })

    it('rejects over the limit with retryAfter in seconds', async () => {
        const checkRateLimitWs = (await import('./ws-rate-limit.js')).default
        const route = createRoute({ windowMs: 60_000, maxRequests: 1 })

        expect(checkRateLimitWs(createWs('10.0.0.9'), route)).toEqual({
            allowed: true,
        })
        expect(checkRateLimitWs(createWs('10.0.0.9'), route)).toEqual({
            allowed: false,
            retryAfter: 60,
            errorMessage: 'Rate limit exceeded for message_send',
        })
    })

    // feat-197 (L-13): the key used to be the IP address alone.
    describe('the budget of a route belongs to the user', () => {
        const userWs = (userId: string, ip: string): MyWebSocket =>
            ({ getUserData: () => ({ userId, ip }) }) as unknown as MyWebSocket

        it('two users behind one address do not share it', async () => {
            const checkRateLimitWs = (await import('./ws-rate-limit.js')).default
            const route = createRoute({ windowMs: 60_000, maxRequests: 1 })

            expect(checkRateLimitWs(userWs('1', '10.0.0.5'), route).allowed).toBe(true)
            expect(checkRateLimitWs(userWs('1', '10.0.0.5'), route).allowed).toBe(false)
            expect(checkRateLimitWs(userWs('2', '10.0.0.5'), route).allowed).toBe(true)
        })

        it('one user on several addresses, or several sockets, has one budget', async () => {
            const checkRateLimitWs = (await import('./ws-rate-limit.js')).default
            const route = createRoute({ windowMs: 60_000, maxRequests: 2 })

            expect(checkRateLimitWs(userWs('3', '10.0.0.6'), route).allowed).toBe(true)
            expect(checkRateLimitWs(userWs('3', '10.0.0.7'), route).allowed).toBe(true)
            expect(checkRateLimitWs(userWs('3', '10.0.0.8'), route).allowed).toBe(false)
        })

        it('a user id and an address that read the same are different keys', async () => {
            const checkRateLimitWs = (await import('./ws-rate-limit.js')).default
            const route = createRoute({ windowMs: 60_000, maxRequests: 1 })

            expect(checkRateLimitWs(userWs('10.0.0.9', '10.0.0.1'), route).allowed).toBe(true)
            expect(checkRateLimitWs(createWs('10.0.0.9'), route).allowed).toBe(true)
        })
    })

    it('fails closed when the configured limit cannot be checked', async () => {
        const { rateLimitStore } = await import('./rate-limit-store.js')
        vi.spyOn(rateLimitStore, 'consume').mockImplementationOnce(() => {
            throw new Error('counter unavailable')
        })

        const checkRateLimitWs = (await import('./ws-rate-limit.js')).default

        const result = checkRateLimitWs(
            createWs(),
            createRoute({ windowMs: 60_000, maxRequests: 10 }),
        )

        expect(result).toMatchObject({
            allowed: false,
            errorMessage: 'Rate limit check failed',
            retryAfter: 1,
        })
    })
})
