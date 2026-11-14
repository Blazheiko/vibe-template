import { type } from '@arktype/type'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { defineRawRoute } from '#app/routing/define-raw-route.js'
import type { HttpContext, Payload } from '#vendor/types/types.js'
import type { ResponseCheck } from '#vendor/utils/validation/validate-response.js'

// Runtime ResponseSchema check on the HTTP path (feat-044, plan §4.3.1). Goes
// through the handler registered with uWS and the real sendResponse.

type Handler = (res: unknown, req: unknown) => unknown
const handlers = new Map<string, Handler>()
const fakeApp = {
    ws: vi.fn(),
    listen: vi.fn((_h: string, _p: number, cb: (token: unknown) => void) => {
        cb({})
    }),
    ...Object.fromEntries(
        ['get', 'post', 'put', 'patch', 'del', 'any'].map((method) => [
            method,
            vi.fn((path: string, handler: Handler) => {
                handlers.set(`${method} ${path}`, handler)
            }),
        ]),
    ),
}

const { logger } = vi.hoisted(() => ({
    logger: {
        warn: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
        trace: vi.fn(),
        child: vi.fn(),
    },
}))
logger.child.mockReturnValue(logger)

vi.mock('uWebSockets.js', () => ({
    App: () => fakeApp,
    us_listen_socket_close: vi.fn(),
}))
vi.mock('#vendor/utils/logger.js', () => ({ default: logger }))
vi.mock('#logger', () => ({ default: logger }))
vi.mock('#vendor/utils/network/get-ip.js', () => ({
    default: () => '127.0.0.1',
}))
vi.mock('#app/routes/http-routes.js', () => ({ default: [] }))
vi.mock('#app/routes/ws-routes.js', () => ({ default: [] }))
vi.mock('#vendor/utils/network/ws-handlers.js', () => ({
    onMessage: vi.fn(),
    onOpen: vi.fn(),
    onClose: vi.fn(),
    handleUpgrade: vi.fn(),
    closeAllWs: vi.fn(),
}))
vi.mock('#vendor/start/static-server.js', () => ({
    cacheStaticSource: vi.fn().mockResolvedValue(null),
    staticHandler: vi.fn(),
    staticCacheHandler: vi.fn(),
}))
// A route with the `deny` middleware is stopped with 401 before its handler.
vi.mock('#vendor/utils/middlewares/core/execute-httpMiddlewares.js', () => ({
    default: vi.fn((middlewares: string[], context: HttpContext) => {
        if (middlewares.includes('deny')) {
            context.responseData.status = 401
            context.responseData.payload = { status: 'error', code: 'unauthorized' }
            return Promise.resolve(false)
        }
        return Promise.resolve(true)
    }),
}))

const { createResponseCheck, __resetResponseValidationLog } =
    await import('#vendor/utils/validation/validate-response.js')

const UserSchema = type({ id: 'number', email: 'string' })
const ReadySchema = type({ status: "'ok' | 'unavailable'" })

interface Setup {
    status?: number
    headers?: Record<string, string>
    cookie?: boolean
    payload?: unknown
    throws?: boolean
    middlewares?: string[]
    responseCheck: ResponseCheck | null
}

const spyCheck = (): ResponseCheck & ReturnType<typeof vi.fn> =>
    vi.fn((payload: unknown) => ({ ok: true, payload })) as never

const route = (name: string, setup: Setup) => ({
    ...defineRawRoute({
        url: name,
        method: 'get',
        handler: (context: HttpContext) => {
            if (setup.throws === true) throw new Error('handler failed')
            if (setup.status !== undefined) context.responseData.status = setup.status
            for (const [headerName, value] of Object.entries(setup.headers ?? {})) {
                context.responseData.headers.push({ name: headerName, value })
            }
            if (setup.cookie === true) context.responseData.setCookie('sid', 'x')
            return setup.payload as Payload
        },
    }),
    url: `api/${name}`,
    middlewares: setup.middlewares ?? [],
    responseCheck: setup.responseCheck,
})

interface Sent {
    status: string
    headers: [string, string][]
    body: string | undefined
}

const call = async (name: string): Promise<Sent> => {
    let status = ''
    let body: string | undefined
    const headers: [string, string][] = []
    let done: () => void = () => {}
    const finished = new Promise<void>((resolve) => {
        done = resolve
    })
    const res = {
        cork: (cb: () => void) => {
            cb()
            return res
        },
        onAborted: () => res,
        writeStatus: (s: string) => {
            status = s
            return res
        },
        writeHeader: (headerName: string, value: string) => {
            headers.push([headerName, value])
            return res
        },
        end: (chunk?: string) => {
            body = chunk
            done()
            return res
        },
        endWithoutBody: () => {
            done()
            return res
        },
        close: () => {
            done()
            return res
        },
    }
    const req = {
        getUrl: () => `/api/${name}`,
        getMethod: () => 'get',
        getQuery: () => '',
        getParameter: () => '',
        getHeader: () => '',
        forEach: () => {},
    }
    const handler = handlers.get(`get /api/${name}`)
    if (handler === undefined) throw new Error(`no handler for ${name}`)
    await handler(res, req)
    await finished
    return { status, headers, body }
}

const header = (sent: Sent, name: string): string[] =>
    sent.headers.filter(([n]) => n.toLowerCase() === name.toLowerCase()).map(([, v]) => v)

const strict = createResponseCheck(UserSchema, { mode: 'strict' })
const log = createResponseCheck(UserSchema, { mode: 'log' })
const invalidUser = { id: 'not-a-number', email: 'leak@example.com' }
const userWithSecret = { id: 1, email: 'a@b.c', passwordHash: 'hash-secret' }

const skipped = {
    middleware: spyCheck(),
    thrown: spyCheck(),
    redirect: spyCheck(),
    noContent: spyCheck(),
    resetContent: spyCheck(),
    emptyOk: spyCheck(),
}

describe('HTTP runtime response validation', () => {
    beforeAll(async () => {
        const { initServer } = await import('./server.js')
        await initServer({
            httpRoutes: [
                route('strict-valid', {
                    payload: { id: 1, email: 'a@b.c' },
                    responseCheck: strict,
                }),
                route('strict-invalid', { payload: invalidUser, responseCheck: strict }),
                route('log-invalid', { payload: invalidUser, responseCheck: log }),
                route('log-extra', { payload: userWithSecret, responseCheck: log }),
                route('strict-extra', { payload: userWithSecret, responseCheck: strict }),
                route('ready-503', {
                    status: 503,
                    payload: { status: 'unavailable' },
                    responseCheck: createResponseCheck(ReadySchema, { mode: 'strict' }),
                }),
                route('strict-invalid-headers', {
                    payload: invalidUser,
                    headers: { ETag: '"abc"', 'Content-Disposition': 'attachment; x.csv' },
                    cookie: true,
                    responseCheck: strict,
                }),
                route('middleware-stop', {
                    payload: { id: 1, email: 'a@b.c' },
                    middlewares: ['deny'],
                    responseCheck: skipped.middleware,
                }),
                route('handler-throws', { throws: true, responseCheck: skipped.thrown }),
                route('redirect', {
                    status: 302,
                    payload: { id: 'x' },
                    headers: { Location: '/x' },
                    responseCheck: skipped.redirect,
                }),
                route('no-content', {
                    status: 204,
                    payload: { id: 'x' },
                    responseCheck: skipped.noContent,
                }),
                route('reset-content', {
                    status: 205,
                    payload: { id: 'x' },
                    responseCheck: skipped.resetContent,
                }),
                route('empty-ok', { payload: null, responseCheck: skipped.emptyOk }),
            ],
            wsRoutesByUrl: new Map(),
            sourceHttpRoutes: [],
            sourceWsRoutes: [],
        } as never)
    })

    beforeEach(() => {
        logger.warn.mockClear()
        logger.error.mockClear()
        __resetResponseValidationLog()
    })

    it('strict sends a valid response unchanged', async () => {
        const sent = await call('strict-valid')
        expect(sent.status).toBe('200 OK')
        expect(JSON.parse(sent.body ?? '')).toEqual({ id: 1, email: 'a@b.c' })
    })

    it('strict replaces an invalid response with a canonical 500 without details', async () => {
        const sent = await call('strict-invalid')
        expect(sent.status).toBe('500 Internal Server Error')
        expect(JSON.parse(sent.body ?? '')).toEqual({
            status: 'error',
            code: 'internal_error',
            message: 'Internal Server Error',
        })
        expect(sent.body).not.toContain('leak@example.com')
        expect(logger.error).toHaveBeenCalledOnce()
    })

    it('log also replaces a schema mismatch with a 500 (fail-closed)', async () => {
        const sent = await call('log-invalid')
        expect(sent.status).toBe('500 Internal Server Error')
        expect(sent.body).not.toContain('leak@example.com')
        expect(logger.error).toHaveBeenCalledOnce()
    })

    it('log sends the response without undeclared keys and writes a warn', async () => {
        const sent = await call('log-extra')
        expect(sent.status).toBe('200 OK')
        expect(JSON.parse(sent.body ?? '')).toEqual({ id: 1, email: 'a@b.c' })
        expect(sent.body).not.toContain('hash-secret')
        expect(logger.warn).toHaveBeenCalledOnce()
    })

    it('strict answers an undeclared key with a 500', async () => {
        const sent = await call('strict-extra')
        expect(sent.status).toBe('500 Internal Server Error')
        expect(sent.body).not.toContain('hash-secret')
        expect(logger.error).toHaveBeenCalledOnce()
    })

    it('checks a handler 503 (/ready) and lets a valid one through', async () => {
        const sent = await call('ready-503')
        expect(sent.status).toBe('503 Service Unavailable')
        expect(JSON.parse(sent.body ?? '')).toEqual({ status: 'unavailable' })
        expect(logger.error).not.toHaveBeenCalled()
    })

    it('strict 500 drops the handler headers but keeps the session cookie', async () => {
        const sent = await call('strict-invalid-headers')
        expect(sent.status).toBe('500 Internal Server Error')
        expect(header(sent, 'etag')).toEqual([])
        expect(header(sent, 'content-disposition')).toEqual([])
        expect(header(sent, 'set-cookie').some((value) => value.startsWith('sid=x'))).toBe(true)
    })

    it('does not check a response a middleware stopped', async () => {
        const sent = await call('middleware-stop')
        expect(sent.status).toBe('401 Unauthorized')
        expect(skipped.middleware).not.toHaveBeenCalled()
    })

    it('does not check when the handler throws', async () => {
        const sent = await call('handler-throws')
        expect(sent.status).toBe('500 Internal Server Error')
        expect(skipped.thrown).not.toHaveBeenCalled()
    })

    it.each([
        ['redirect', 'redirect', '302 Found'],
        ['no-content', 'noContent', '204 No Content'],
        ['reset-content', 'resetContent', '205 Reset Content'],
        ['empty-ok', 'emptyOk', '204 No Content'],
    ] as const)(
        '%s: no body, no check, sending unchanged (200 → 204 included)',
        async (name, key, status) => {
            const sent = await call(name)
            expect(sent.status).toBe(status)
            expect(skipped[key]).not.toHaveBeenCalled()
        },
    )
})
