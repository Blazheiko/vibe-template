import { type } from '@arktype/type'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { defineRawRoute } from '#app/routing/define-raw-route.js'

const getDataMock = vi.fn()

vi.mock('uWebSockets.js', () => ({
    App: (): Record<string, never> => ({}),
}))

vi.mock('#app/routes/http-routes.js', () => ({
    default: [],
}))

vi.mock('#app/routes/ws-routes.js', () => ({
    default: [],
}))

vi.mock('#vendor/utils/network/ws-handlers.js', () => ({
    onMessage: vi.fn(),
    onOpen: vi.fn(),
    onClose: vi.fn(),
    handleUpgrade: vi.fn(),
    closeAllWs: vi.fn(),
}))

vi.mock('#vendor/utils/middlewares/core/execute-httpMiddlewares.js', () => ({
    default: vi.fn().mockResolvedValue(true),
}))

vi.mock('#vendor/utils/network/http-request-handlers.js', async () => {
    const actual = await vi.importActual<object>('#vendor/utils/network/http-request-handlers.js')

    return {
        ...actual,
        getData: getDataMock,
    }
})

describe('readAndParseBody', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('throws ValidationError for invalid HTTP body', async () => {
        const { readAndParseBody } = await import('./server.js')
        const route = defineRawRoute({
            url: '/login',
            method: 'post',
            validator: type({
                email: 'string.email',
            }),
            handler: () => ({ ok: true }),
        })

        getDataMock.mockResolvedValue({
            payload: {
                email: 'bad-email',
            },
            files: null,
        })

        await expect(
            readAndParseBody(
                {} as never,
                {
                    ip: '127.0.0.1',
                    cookies: new Map(),
                    query: new URLSearchParams(),
                    headers: new Map(),
                    params: {},
                    contentType: 'application/json',
                    bodyKind: 'json',
                    hasBody: true,
                },
                route,
                { aborted: false },
            ),
        ).rejects.toMatchObject({ name: 'ValidationError' })
    })

    it('returns validated payload for valid HTTP body', async () => {
        const { readAndParseBody } = await import('./server.js')
        const route = defineRawRoute({
            url: '/login',
            method: 'post',
            validator: type({
                email: 'string.email',
            }),
            handler: () => ({ ok: true }),
        })

        getDataMock.mockResolvedValue({
            payload: {
                email: 'user@example.com',
            },
            files: null,
        })

        await expect(
            readAndParseBody(
                {} as never,
                {
                    ip: '127.0.0.1',
                    cookies: new Map(),
                    query: new URLSearchParams(),
                    headers: new Map(),
                    params: {},
                    contentType: 'application/json',
                    bodyKind: 'json',
                    hasBody: true,
                },
                route,
                { aborted: false },
            ),
        ).resolves.toEqual({
            payload: {
                email: 'user@example.com',
            },
            files: null,
        })
    })
})

describe('validateQuery', () => {
    it('returns null when route has no queryValidator', async () => {
        const { validateQuery } = await import('./server.js')
        const route = defineRawRoute({
            url: '/ping',
            method: 'get',
            handler: () => ({ ok: true }),
        })

        expect(
            validateQuery(
                {
                    query: new URLSearchParams('ignored=1'),
                } as never,
                route,
            ),
        ).toBeNull()
    })

    it('returns typed query values after validation', async () => {
        const { validateQuery } = await import('./server.js')
        const route = defineRawRoute({
            url: '/items',
            method: 'get',
            queryValidator: type({
                page: 'string.integer.parse',
            }),
            handler: () => ({ ok: true }),
        })

        expect(
            validateQuery(
                {
                    query: new URLSearchParams('page=2'),
                } as never,
                route,
            ),
        ).toEqual({ page: 2 })
    })

    it('applies query defaults', async () => {
        const { validateQuery } = await import('./server.js')
        const route = defineRawRoute({
            url: '/items',
            method: 'get',
            queryValidator: type({
                page: [
                    type('string.integer.parse').pipe(type('number > 0')),
                    '=',
                    '1',
                ] as unknown as never,
            }),
            handler: () => ({ ok: true }),
        })

        expect(
            validateQuery(
                {
                    query: new URLSearchParams(),
                } as never,
                route,
            ),
        ).toEqual({ page: 1 })
    })

    it('rejects invalid query values', async () => {
        const { validateQuery } = await import('./server.js')
        const route = defineRawRoute({
            url: '/items',
            method: 'get',
            queryValidator: type({
                page: 'string.integer.parse',
            }),
            handler: () => ({ ok: true }),
        })

        expect(() =>
            validateQuery(
                {
                    query: new URLSearchParams('page=abc'),
                } as never,
                route,
            ),
        ).toThrow()
    })

    it('collects queryArrays keys before validation', async () => {
        const { validateQuery } = await import('./server.js')
        const route = defineRawRoute({
            url: '/items',
            method: 'get',
            queryValidator: type({
                tags: 'string[]',
            }),
            queryArrays: ['tags'],
            handler: () => ({ ok: true }),
        })

        expect(
            validateQuery(
                {
                    query: new URLSearchParams('tags=a&tags=b'),
                } as never,
                route,
            ),
        ).toEqual({ tags: ['a', 'b'] })
    })
})
