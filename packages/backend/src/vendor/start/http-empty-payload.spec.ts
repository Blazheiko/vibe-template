import { beforeAll, describe, expect, it, vi } from 'vitest'

import { defineRawRoute } from '#app/routing/define-raw-route.js'
import type { HttpContext, Payload } from '#vendor/types/types.js'

// Goes through the handler registered with uWS (server.get) and the real
// sendResponse, so status line, written headers and body are what a client sees.

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
vi.mock('#vendor/utils/middlewares/core/execute-httpMiddlewares.js', () => ({
    default: vi.fn().mockResolvedValue(true),
}))

interface Setup {
    status?: number
    headers?: Record<string, string>
    cookie?: boolean
    payload: unknown
}

// Each case gets its own route so the handler can set status, headers and cookies.
const cases = new Map<string, Setup>()
const route = (name: string, setup: Setup) => {
    cases.set(name, setup)
    return {
        ...defineRawRoute({
            url: name,
            method: 'get',
            handler: (context: HttpContext) => {
                if (setup.status !== undefined) context.responseData.status = setup.status
                for (const [headerName, value] of Object.entries(setup.headers ?? {})) {
                    context.responseData.headers.push({ name: headerName, value })
                }
                if (setup.cookie === true) context.responseData.setCookie('sid', 'x')
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

const call = async (name: string): Promise<Sent> => {
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
        getParameter: () => '',
        getHeader: () => '',
        forEach: () => {},
    }
    const handler = handlers.get(`get /api/${name}`)
    if (handler === undefined) throw new Error(`no handler for ${name}`)
    await handler(res, req)
    await finished
    return { status, headers, body, withoutBody }
}

const contentTypes = (sent: Sent): string[] =>
    sent.headers.filter(([n]) => n.toLowerCase() === 'content-type').map(([, v]) => v)

const expectNoBody = (sent: Sent): void => {
    expect(sent.body ?? '').toBe('')
    expect(contentTypes(sent)).toEqual([])
}

describe('HTTP response with an empty payload', () => {
    beforeAll(async () => {
        const { initServer } = await import('./server.js')
        await initServer({
            httpRoutes: [
                route('null', { payload: null }),
                route('undefined', { payload: undefined }),
                route('created-null', { status: 201, payload: null }),
                route('accepted-null', { status: 202, payload: null }),
                route('no-content-object', { status: 204, payload: { a: 1 } }),
                route('reset-object', { status: 205, payload: { a: 1 } }),
                route('forbidden-null', { status: 403, payload: null }),
                route('server-error-null', { status: 500, payload: null }),
                route('teapot-null', { status: 418, payload: null }),
                route('null-text-plain', {
                    payload: null,
                    headers: { 'Content-Type': 'text/plain' },
                }),
                route('null-lower', { payload: null, headers: { 'content-type': 'text/plain' } }),
                route('null-upper', { payload: null, headers: { 'CONTENT-TYPE': 'text/plain' } }),
                route('redirect-html', {
                    status: 302,
                    payload: null,
                    headers: { Location: '/x', 'Content-Type': 'text/html' },
                }),
                route('not-modified-object', {
                    status: 304,
                    payload: { a: 1 },
                    headers: { 'Content-Type': 'application/json' },
                }),
                route('null-cookie', { payload: null, cookie: true }),
                route('null-content-length', {
                    payload: null,
                    headers: { 'Content-Length': '12' },
                }),
                route('accepted-content-length', {
                    status: 202,
                    payload: null,
                    headers: { 'content-length': '12' },
                }),
                route('object', { payload: { a: 1 } }),
                route('false', { payload: false }),
                route('zero', { payload: 0 }),
                route('empty-string', { payload: '' }),
                route('redirect', { status: 302, payload: {}, headers: { Location: '/x' } }),
            ].map((route) => ({ ...route, responseCheck: null })),
            wsRoutesByUrl: new Map(),
            sourceHttpRoutes: [],
            sourceWsRoutes: [],
        } as never)
    })

    describe('new behaviour', () => {
        it.each(['null', 'undefined'])('handler returns %s → 204 without body', async (name) => {
            const sent = await call(name)

            expect(sent.status).toBe('204 No Content')
            expectNoBody(sent)
            // 204 must not carry Content-Length (RFC 9110 §8.6).
            expect(sent.withoutBody).toBe(true)
        })

        it.each([
            ['created-null', '201 Created'],
            ['accepted-null', '202 Accepted'],
        ])('%s keeps its status without body', async (name, status) => {
            const sent = await call(name)

            expect(sent.status).toBe(status)
            expectNoBody(sent)
            // Content-Length: 0 is correct here, so res.end() is used.
            expect(sent.withoutBody).toBe(false)
        })

        it.each([
            ['no-content-object', '204 No Content'],
            ['reset-object', '205 Reset Content'],
        ])('%s drops the payload', async (name, status) => {
            const sent = await call(name)

            expect(sent.status).toBe(status)
            expectNoBody(sent)
        })

        it.each([
            ['forbidden-null', '403 Forbidden', 'forbidden', 'Forbidden'],
            [
                'server-error-null',
                '500 Internal Server Error',
                'internal_error',
                'Internal Server Error',
            ],
            ['teapot-null', "418 I'm a Teapot", 'bad_request', "I'm a Teapot"],
        ])('%s → canonical error body', async (name, status, code, message) => {
            const sent = await call(name)

            expect(sent.status).toBe(status)
            expect(contentTypes(sent)).toEqual(['application/json'])
            expect(JSON.parse(sent.body ?? '')).toEqual({ status: 'error', code, message })
        })

        it.each(['null-text-plain', 'null-lower', 'null-upper'])(
            '%s: controller Content-Type is not written without a body',
            async (name) => {
                const sent = await call(name)

                expect(sent.status).toBe('204 No Content')
                expectNoBody(sent)
            },
        )

        it('302 with a controller Content-Type → no body, no Content-Type', async () => {
            const sent = await call('redirect-html')

            expect(sent.status).toBe('302 Found')
            expect(sent.headers).toContainEqual(['Location', '/x'])
            expectNoBody(sent)
        })

        it('304 with an object and a controller Content-Type → no body, no Content-Type', async () => {
            const sent = await call('not-modified-object')

            expect(sent.status).toBe('304 Not Modified')
            expectNoBody(sent)
            expect(sent.withoutBody).toBe(true)
        })

        it.each([
            ['null-content-length', '204 No Content'],
            ['accepted-content-length', '202 Accepted'],
        ])('%s: controller Content-Length is not written without a body', async (name, status) => {
            const sent = await call(name)

            expect(sent.status).toBe(status)
            expect(sent.headers.filter(([n]) => n.toLowerCase() === 'content-length')).toEqual([])
            expectNoBody(sent)
        })

        it('still writes cookies on a 204', async () => {
            const sent = await call('null-cookie')

            expect(sent.status).toBe('204 No Content')
            expect(
                sent.headers.some(
                    ([n, v]) => n.toLowerCase() === 'set-cookie' && v.startsWith('sid=x'),
                ),
            ).toBe(true)
            expectNoBody(sent)
        })
    })

    describe('regression', () => {
        it.each([
            ['object', '{"a":1}'],
            ['false', 'false'],
            ['zero', '0'],
            ['empty-string', '""'],
        ])('%s → 200 with JSON', async (name, body) => {
            const sent = await call(name)

            expect(sent.status).toBe('200 OK')
            expect(contentTypes(sent)).toEqual(['application/json'])
            expect(sent.body).toBe(body)
        })

        it('302 → no body', async () => {
            const sent = await call('redirect')

            expect(sent.status).toBe('302 Found')
            expectNoBody(sent)
        })
    })
})
