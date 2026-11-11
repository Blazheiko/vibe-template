import { beforeEach, describe, expect, it, vi } from 'vitest'

import { defineWsRoute } from '#app/routing/define-ws-route.js'

// feat-180 (ADR 0006, Д-WS1): the reply to a WS request carries the request's `id` back,
// whatever the outcome: the client keeps its pending requests by that id, so a reply
// without it would leave the request waiting until its timeout.

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
vi.mock('../rate-limit/ws-rate-limit.js', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>()
    return { ...actual, default: checkRateLimitWsMock }
})

const dispatch = async (
    handler: () => unknown,
    message: { event: string; id?: string; timestamp: number; payload: object },
) => {
    const route = defineWsRoute({ url: 'event_x', handler: handler as never })
    const wsApiDispatcher = (await import('./ws-api-dispatcher.js')).default
    return wsApiDispatcher(
        message as never,
        { getUserData: () => ({ token: '' }) } as never,
        { token: '', userId: '9' } as never,
        {} as never,
        { [route.url]: { ...route, responseCheck: null } },
    )
}

describe('ws-api-dispatcher echoes the request id', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        executeMiddlewaresMock.mockResolvedValue(true)
        checkRateLimitWsMock.mockReturnValue({ allowed: true })
    })

    const request = { event: 'event_x', id: 'req-7', timestamp: 5, payload: {} }

    it('on a reply', async () => {
        const result = await dispatch(() => ({ status: 'ok' }), request)
        expect(result).toMatchObject({ id: 'req-7', event: 'event_x', data: { status: 'ok' } })
    })

    it('on an unknown route', async () => {
        const result = await dispatch(() => ({}), { ...request, event: 'nowhere' })
        expect(result).toMatchObject({ id: 'req-7', error: { code: 'not_found' } })
    })

    it('on a thrown error', async () => {
        const result = await dispatch(() => {
            throw new Error('boom')
        }, request)
        expect(result).toMatchObject({ id: 'req-7', error: { code: 'internal_error' } })
    })

    it('on a rate-limit refusal', async () => {
        checkRateLimitWsMock.mockReturnValue({ allowed: false, errorMessage: 'x', retryAfter: 3 })
        const result = await dispatch(() => ({}), request)
        expect(result).toMatchObject({ id: 'req-7', error: { code: 'rate_limited' } })
    })

    it('leaves the id out when the request had none', async () => {
        const { id: _id, ...withoutId } = request
        const result = await dispatch(() => ({ status: 'ok' }), withoutId)
        expect('id' in result).toBe(false)
    })
})
