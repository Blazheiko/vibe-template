import { beforeAll, describe, expect, it, vi } from 'vitest'

import { defineRoute } from '#app/routing/define-route.js'
import type { HttpContext, Payload } from '#vendor/types/types.js'
import sessionConfig from '#config/session.js'

// API responses default to Cache-Control: no-store (code-issues item 42). Goes
// through the handler registered with uWS and the real sendResponse /
// sendErrorResponse, so the written headers are what a client sees.

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

vi.mock('uWebSockets.js', () => ({
    App: () => fakeApp,
    us_listen_socket_close: vi.fn(),
}))
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
// CORS on, so the error path can be checked for the headers a browser needs.
vi.mock('#config/cors.js', () => ({
    default: {
        enabled: true,
        allowedOrigins: ['https://app.test'],
        methods: 'GET,POST',
        maxAge: 600,
        exposeHeaders: '',
        allowHeaders: 'content-type',
        credentials: true,
    },
}))
vi.mock('#vendor/utils/middlewares/core/execute-httpMiddlewares.js', () => ({
    default: vi.fn().mockResolvedValue(true),
}))

interface Setup {
    status?: number
    headers?: Record<string, string>
    cookie?: boolean
    payload: unknown
    throws?: boolean
}

// Each case gets its own route so the handler can set status, headers and cookies.
const cases = new Map<string, Setup>()
const route = (name: string, setup: Setup) => {
    cases.set(name, setup)
    return {
        ...defineRoute({
            url: name,
            method: 'get',
            handler: (context: HttpContext) => {
                if (setup.status !== undefined) context.responseData.status = setup.status
                for (const [headerName, value] of Object.entries(setup.headers ?? {})) {
                    context.responseData.headers.push({ name: headerName, value })
                }
                if (setup.cookie === true) {
                    context.responseData.setCookie(sessionConfig.cookieName, 'session-value')
                    context.responseData.setCookie('sid', 'x')
                }
                if (setup.throws === true) throw new Error('boom')
                return setup.payload as Payload
            },
        }),
        url: `api/${name}`,
        middlewares: [],
    }
}

interface Sent {
    status: string
    headers: [string, string][]
    body: string | undefined
    // true when ended via endWithoutBody(): uWS then writes no Content-Length.
    withoutBody: boolean
}

const call = async (name: string, origin?: string, param = ''): Promise<Sent> => {
    let status = ''
    let body: string | undefined
    let withoutBody = false
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
            withoutBody = true
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
        getParameter: () => param,
        getHeader: (headerName: string) =>
            headerName === 'origin' && origin !== undefined ? origin : '',
        forEach: (cb: (key: string, value: string) => void) => {
            if (origin !== undefined) cb('origin', origin)
        },
    }
    const handler = handlers.get(`get /api/${name}`)
    if (handler === undefined) throw new Error(`no handler for ${name}`)
    await handler(res, req)
    await finished
    return { status, headers, body, withoutBody }
}

const cacheControl = (sent: Sent): string[] =>
    sent.headers.filter(([n]) => n.toLowerCase() === 'cache-control').map(([, v]) => v)

describe('Cache-Control on API responses', () => {
    beforeAll(async () => {
        const { initServer } = await import('./server.js')
        await initServer({
            httpRoutes: [
                route('json', { payload: { a: 1 } }),
                route('empty', { payload: null }),
                route('created', { status: 201, payload: { id: 1 } }),
                route('forbidden', { status: 403, payload: { status: 'forbidden' } }),
                route('thrown', { payload: null, throws: true }),
                route('cookie', { payload: { a: 1 }, cookie: true }),
                route('cookie-thrown', { payload: null, cookie: true, throws: true }),
                // The router fills parametersKey from the URL; this harness skips the router.
                { ...route('item/:id', { payload: { a: 1 } }), parametersKey: ['id'] },
                route('own', {
                    payload: { a: 1 },
                    headers: { 'Cache-Control': 'public, max-age=60' },
                }),
                route('own-lower', {
                    payload: { a: 1 },
                    headers: { 'cache-control': 'private, max-age=5' },
                }),
            ].map((route) => ({ ...route, responseCheck: null })),
            wsRoutesByUrl: new Map(),
            sourceHttpRoutes: [],
            sourceWsRoutes: [],
        } as never)
    })

    it.each([
        ['json', '200 OK'],
        ['empty', '204 No Content'],
        ['created', '201 Created'],
        ['forbidden', '403 Forbidden'],
        ['cookie', '200 OK'],
    ])('%s → no-store', async (name, status) => {
        const sent = await call(name)
        expect(sent.status).toBe(status)
        expect(cacheControl(sent)).toEqual(['no-store'])
    })

    it('error responses from handleError are no-store too', async () => {
        const sent = await call('thrown')
        expect(sent.status).toBe('500 Internal Server Error')
        expect(cacheControl(sent)).toEqual(['no-store'])
    })

    // feat-089: a thrown error answers like a returned one for the session: a session cookie
    // set before the throw (a login that swapped the session) reaches the client.
    // feat-095 (code review): only that one; another cookie of the failed handler is dropped.
    it('keeps the session cookie set before a thrown error, and only that one', async () => {
        const sent = await call('cookie-thrown')
        expect(sent.status).toBe('500 Internal Server Error')
        const setCookie = sent.headers.filter(([n]) => n.toLowerCase() === 'set-cookie')
        expect(setCookie).toHaveLength(1)
        expect(setCookie[0]?.[1]).toMatch(new RegExp(`^${sessionConfig.cookieName}=session-value`))
        expect(JSON.parse(sent.body ?? '')).toMatchObject({ code: 'internal_error' })
    })

    // feat-095 (code review): the Origin was read after the metadata, whose path-parameter
    // check can throw first; that 400 went out without CORS headers.
    it('writes the CORS headers on a 400 for an invalid path parameter', async () => {
        const sent = await call('item/:id', 'https://app.test', 'bad value!')
        expect(sent.status).toBe('400 Bad Request')
        expect(JSON.parse(sent.body ?? '')).toMatchObject({ code: 'bad_request' })
        expect(sent.headers).toContainEqual(['Access-Control-Allow-Origin', 'https://app.test'])
    })

    // feat-089: before, sendErrorResponse wrote no CORS headers, so a cross-origin
    // browser client could not read the body of any error thrown by a handler.
    it('writes the CORS headers on a thrown error', async () => {
        const sent = await call('thrown', 'https://app.test')
        expect(sent.status).toBe('500 Internal Server Error')
        expect(sent.headers).toContainEqual(['Access-Control-Allow-Origin', 'https://app.test'])
        expect(sent.headers).toContainEqual(['Access-Control-Allow-Credentials', 'true'])
    })

    it.each([
        ['own', 'public, max-age=60'],
        ['own-lower', 'private, max-age=5'],
    ])('keeps the Cache-Control a controller set (%s)', async (name, value) => {
        expect(cacheControl(await call(name))).toEqual([value])
    })
})
