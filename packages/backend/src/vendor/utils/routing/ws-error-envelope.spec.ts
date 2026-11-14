import { type } from '@arktype/type'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { defineRawWsRoute } from '#app/routing/define-ws-route.js'
import type { RouteItem } from '#vendor/types/types.js'

// feat-048: every transport error of the WS dispatcher has status 'error', data null and
// the error envelope — the client can rely on data === null.

const executeMiddlewaresMock = vi.fn()
const checkRateLimitWsMock = vi.fn()

vi.mock('#vendor/utils/middlewares/core/execute-httpMiddlewares.js', () => ({
    executeWsMiddlewares: executeMiddlewaresMock,
}))

const { logger } = vi.hoisted(() => {
    const mock = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(), child: vi.fn() }
    mock.child.mockReturnValue(mock)
    return { logger: mock }
})
vi.mock('#vendor/utils/logger.js', () => ({ default: logger }))

vi.mock('../rate-limit/ws-rate-limit.js', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    default: checkRateLimitWsMock,
}))

const dispatch = async (event: string, payload: unknown, route?: RouteItem) => {
    const wsApiDispatcher = (await import('./ws-api-dispatcher.js')).default
    const routes = route === undefined ? {} : { [route.url]: { ...route, responseCheck: null } }
    return wsApiDispatcher(
        { event, timestamp: 1, payload } as never,
        { getUserData: () => ({ token: '' }) } as never,
        { token: '' } as never,
        {} as never,
        routes,
    )
}

describe('ws-api-dispatcher transport errors (feat-048)', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        executeMiddlewaresMock.mockResolvedValue(true)
        checkRateLimitWsMock.mockReturnValue({ allowed: true })
    })

    it('not_found has data null', async () => {
        const result = await dispatch('api/missing', null)
        expect(result).toMatchObject({
            status: 'error',
            data: null,
            error: { code: 'not_found' },
        })
    })

    // feat-149: the route map is looked up by a name the client sends; members of
    // Object.prototype are not routes.
    it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf'])(
        'answers not_found for %s, without an error log',
        async (event) => {
            const result = await dispatch(event, null)
            expect(result).toMatchObject({
                status: 'error',
                data: null,
                error: { code: 'not_found' },
            })
            expect(logger.error).not.toHaveBeenCalled()
        },
    )

    it('validation_failed has data null', async () => {
        const route = defineRawWsRoute({
            url: 'typing',
            validator: type({ roomId: 'string' }),
            handler: () => ({ ok: true }),
        })
        const result = await dispatch('typing', { roomId: 1 }, route)
        expect(result).toMatchObject({
            status: 'error',
            data: null,
            error: { code: 'validation_failed', details: { kind: 'validation' } },
        })
    })

    it('internal_error drops data a handler wrote before it threw', async () => {
        const route = defineRawWsRoute({
            url: 'partial',
            handler: (context) => {
                context.responseData.data = { partial: 'secret' }
                throw new Error('boom')
            },
        })
        const result = await dispatch('partial', null, route)
        expect(result).toMatchObject({
            status: 'error',
            data: null,
            error: { code: 'internal_error' },
        })
        expect(JSON.stringify(result)).not.toContain('secret')
    })

    it('an event with an empty route name is not_found with data null', async () => {
        // ':only'.split(':')[0] is '', not undefined: no route matches it.
        const result = await dispatch(':only', null)
        expect(result).toMatchObject({
            status: 'error',
            data: null,
            error: { code: 'not_found' },
        })
    })

    it('rate_limited has data null', async () => {
        checkRateLimitWsMock.mockReturnValue({ allowed: false, retryAfter: 5 })
        const route = defineRawWsRoute({ url: 'limited', handler: () => ({ ok: true }) })
        const result = await dispatch('limited', null, route)
        expect(result).toMatchObject({
            status: 'error',
            data: null,
            error: { code: 'rate_limited' },
        })
    })

    it('a middleware that stops without writing data leaves data null', async () => {
        executeMiddlewaresMock.mockResolvedValue(false)
        const route = defineRawWsRoute({ url: 'stopped', handler: () => ({ ok: true }) })
        const result = await dispatch('stopped', null, { ...route, middlewares: ['deny'] })
        expect(result.data).toBeNull()
    })
})
