import { type } from '@arktype/type'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { defineRawWsRoute } from '#app/routing/define-ws-route.js'
import type { ResponseCheck } from '#vendor/utils/validation/validate-response.js'

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

vi.mock('../rate-limit/ws-rate-limit.js', () => ({
    default: checkRateLimitWsMock,
    createWsRateLimitErrorResponse: vi.fn(),
}))

describe('ws-api-dispatcher validation', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        executeMiddlewaresMock.mockResolvedValue(true)
        checkRateLimitWsMock.mockReturnValue({ allowed: true })
    })

    it('returns 422 and does not call handler for invalid WS payload', async () => {
        const handler = vi.fn()
        const route = defineRawWsRoute({
            url: 'event_typing',
            validator: type({
                roomId: 'string',
            }),
            handler,
        })

        const wsApiDispatcher = (await import('./ws-api-dispatcher.js')).default
        const result = await wsApiDispatcher(
            {
                event: 'event_typing',
                timestamp: Date.now(),
                payload: {
                    roomId: 123,
                },
            },
            {
                getUserData: () => ({
                    token: '',
                }),
            } as never,
            {
                token: '',
            } as never,
            {} as never,
            {
                [route.url]: { ...route, responseCheck: null },
            },
        )

        expect(result).toMatchObject({
            status: 'error',
            error: {
                code: 'validation_failed',
                message: 'Validation failure',
                details: {
                    kind: 'validation',
                    messages: ['roomId must be a string (was a number)'],
                    issues: [{ path: 'roomId', message: 'roomId must be a string (was a number)' }],
                },
            },
        })
        expect(handler).not.toHaveBeenCalled()
    })
})

describe('ws-api-dispatcher runtime response validation (feat-044)', () => {
    const UserSchema = type({ id: 'number', email: 'string' })
    const invalidUser = { id: 'not-a-number', email: 'leak@example.com' }

    beforeEach(async () => {
        vi.clearAllMocks()
        logger.child.mockReturnValue(logger)
        executeMiddlewaresMock.mockResolvedValue(true)
        checkRateLimitWsMock.mockReturnValue({ allowed: true })
        const { __resetResponseValidationLog } =
            await import('#vendor/utils/validation/validate-response.js')
        __resetResponseValidationLog()
    })

    const dispatch = async (data: unknown, responseCheck: ResponseCheck | null) => {
        const route = defineRawWsRoute({ url: 'user_get', handler: () => data as never })
        const wsApiDispatcher = (await import('./ws-api-dispatcher.js')).default
        return wsApiDispatcher(
            { event: 'user_get', timestamp: 1, payload: null },
            { getUserData: () => ({ token: '' }) } as never,
            { token: '' } as never,
            {} as never,
            { [route.url]: { ...route, responseCheck } },
        )
    }

    const check = async (mode: 'strict' | 'log') => {
        const { createResponseCheck } =
            await import('#vendor/utils/validation/validate-response.js')
        return createResponseCheck(UserSchema, { mode })
    }

    it('strict: error envelope with data null and no validation details', async () => {
        const result = await dispatch(invalidUser, await check('strict'))
        expect(result).toMatchObject({
            status: 'error',
            data: null,
            error: { code: 'internal_error', message: 'Internal server error' },
        })
        expect(result.error).not.toHaveProperty('details')
        expect(JSON.stringify(result)).not.toContain('leak@example.com')
        expect(logger.error).toHaveBeenCalledOnce()
    })

    it('strict: a valid reply is unchanged', async () => {
        const result = await dispatch({ id: 1, email: 'a@b.c' }, await check('strict'))
        expect(result).toMatchObject({
            status: '200',
            data: { id: 1, email: 'a@b.c' },
            error: null,
        })
    })

    it('log: a schema mismatch is an error envelope too (fail-closed)', async () => {
        const result = await dispatch(invalidUser, await check('log'))
        expect(result).toMatchObject({ status: 'error', data: null })
        expect(JSON.stringify(result)).not.toContain('leak@example.com')
        expect(logger.error).toHaveBeenCalledOnce()
    })

    it('log: undeclared keys are stripped from data and a warn is written', async () => {
        const result = await dispatch(
            { id: 1, email: 'a@b.c', passwordHash: 'hash-secret' },
            await check('log'),
        )
        expect(result).toMatchObject({
            status: '200',
            data: { id: 1, email: 'a@b.c' },
            error: null,
        })
        expect(JSON.stringify(result)).not.toContain('hash-secret')
        expect(logger.warn).toHaveBeenCalledOnce()
    })

    it('strict: an undeclared key is an error envelope', async () => {
        const result = await dispatch(
            { id: 1, email: 'a@b.c', passwordHash: 'hash-secret' },
            await check('strict'),
        )
        expect(result).toMatchObject({ status: 'error', data: null })
        expect(JSON.stringify(result)).not.toContain('hash-secret')
    })
})

// feat-087: the dispatcher classifies a thrown error like handleError does for HTTP.
describe('ws-api-dispatcher error classification', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        executeMiddlewaresMock.mockResolvedValue(true)
        checkRateLimitWsMock.mockReturnValue({ allowed: true })
    })

    const dispatch = async (handler: () => unknown) => {
        const route = defineRawWsRoute({ url: 'event_x', handler: handler as never })
        const wsApiDispatcher = (await import('./ws-api-dispatcher.js')).default
        return wsApiDispatcher(
            { event: 'event_x', timestamp: 1, payload: {} },
            { getUserData: () => ({ token: '' }) } as never,
            { token: '', userId: '9' } as never,
            {} as never,
            { [route.url]: { ...route, responseCheck: null } },
        )
    }

    it('answers a Redis outage from a handler with service_unavailable, not internal_error', async () => {
        const { RedisUnavailableError } =
            await import('#vendor/utils/network/errors/redis-unavailable-error.js')

        const result = await dispatch(() => {
            throw new RedisUnavailableError()
        })

        expect(result).toMatchObject({
            status: 'error',
            data: null,
            error: { code: 'service_unavailable' },
        })
        // Logged per request for stdout, kept out of Sentry (one event per incident).
        expect(logger.error).toHaveBeenCalledWith(
            expect.objectContaining({ sentrySkip: true }),
            'Request failed: Redis unavailable',
        )
    })

    it('answers any other thrown error with internal_error and logs the context', async () => {
        const err = new Error('boom')

        const result = await dispatch(() => {
            throw err
        })

        expect(result).toMatchObject({ status: 'error', error: { code: 'internal_error' } })
        expect(logger.child).toHaveBeenCalledWith(
            expect.objectContaining({ userId: '9', route: 'event_x', wsEvent: 'event_x' }),
        )
        expect(logger.error).toHaveBeenCalledWith({ err }, 'Handle Error')
    })

    it('keeps a business error returned by the handler in data (feat-048)', async () => {
        const body = { status: 'error', code: 'forbidden', message: 'Access denied' }

        const result = await dispatch(() => body)

        expect(result).toMatchObject({ status: '200', error: null, data: body })
        expect(logger.error).not.toHaveBeenCalled()
    })
})
