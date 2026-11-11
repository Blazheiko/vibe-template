import { beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (res: unknown, req: unknown) => unknown

const handlers = new Map<string, Handler>()

const fakeApp = {
    ws: vi.fn(),
    listen: vi.fn((_host: string, _port: number, callback: (token: unknown) => void) => {
        callback({})
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

vi.mock('#config/cors.js', async (importOriginal) => {
    const actual = await importOriginal<{ default: Record<string, unknown> }>()
    return {
        default: {
            ...actual.default,
            enabled: true,
            allowedOrigins: ['https://app.test'],
        },
    }
})

vi.mock('#app/routes/http-routes.js', () => ({ default: [] }))
vi.mock('#app/routes/ws-routes.js', () => ({ default: [] }))
let currentIp = '127.0.0.1'
vi.mock('#vendor/utils/network/get-ip.js', () => ({
    default: () => currentIp,
}))
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

vi.mock('#config/rate-limit.js', () => ({
    default: {
        httpGlobal: { windowMs: 60_000, max: 3 },
        wsUpgrade: { windowMs: 60_000, max: 3 },
        configError: null,
    },
}))

interface CapturedResponse {
    status: string
    headers: { name: string; value: string }[]
    body: string | undefined
}

const createRes = () => {
    const captured: CapturedResponse = {
        status: '',
        headers: [],
        body: undefined,
    }
    let done: () => void = () => {}
    const finished = new Promise<void>((resolve) => {
        done = resolve
    })
    const res = {
        cork: (callback: () => void) => {
            callback()
            return res
        },
        onAborted: () => res,
        onData: () => res,
        writeStatus: (status: string) => {
            captured.status = status
            return res
        },
        writeHeader: (name: string, value: string) => {
            captured.headers.push({ name, value })
            return res
        },
        end: (body?: string) => {
            captured.body = body
            done()
            return res
        },
        close: () => {
            done()
            return res
        },
    }
    return { res, captured, finished }
}

const createReq = (url: string, method: string, headers: Record<string, string> = {}) => ({
    getUrl: () => url,
    getMethod: () => method,
    getQuery: () => '',
    getParameter: () => '',
    getHeader: (name: string) => headers[name] ?? '',
    forEach: (callback: (key: string, value: string) => void) => {
        Object.entries(headers).forEach(([key, value]) => {
            callback(key, value)
        })
    },
})

const routes = [
    {
        method: 'get',
        url: 'api/rl-test/plain',
        middlewares: [],
        handler: () => ({ ok: true }),
    },
]

const loadServer = async (
    options: {
        pathPrefix?: string
        serveStatic?: boolean
        docPage?: boolean
    } = {},
) => {
    vi.resetModules()
    handlers.clear()
    const pathPrefix = options.pathPrefix ?? 'api'
    vi.doMock('#config/app.js', async (importOriginal) => {
        const actual = await importOriginal<{ default: Record<string, unknown> }>()
        return {
            default: {
                ...actual.default,
                serveStatic: options.serveStatic ?? false,
                ...(options.docPage === true ? { env: 'manual-test', docPage: true } : {}),
                unixPath: undefined,
                pathPrefix,
            },
        }
    })
    const { initServer } = await import('./server.js')
    await initServer({
        httpRoutes: routes.map((route) => ({
            ...route,
            url: route.url.replace(/^api\//, `${pathPrefix}/`),
            responseCheck: null,
        })),
        wsRoutesByUrl: new Map(),
        sourceHttpRoutes: [],
        sourceWsRoutes: [],
    } as never)
}

const call = async (
    key: string,
    url: string,
    method: string,
    headers?: Record<string, string>,
): Promise<CapturedResponse> => {
    const handler = handlers.get(key)
    if (handler === undefined) throw new Error(`No handler registered for ${key}`)
    const { res, captured, finished } = createRes()
    await handler(res, createReq(url, method, headers))
    await finished
    return captured
}

const ORIGIN = { origin: 'https://app.test' }

const route = () => call('get /api/rl-test/plain', '/api/rl-test/plain', 'get')
const notFound = () => call('any /*', '/api/nope', 'get')
const preflight = () => call('any /*', '/api/rl-test/plain', 'options', ORIGIN)

const header = (response: CapturedResponse, name: string) =>
    response.headers.filter((item) => item.name.toLowerCase() === name).map((item) => item.value)

let ipCounter = 0
const freshIp = () => {
    ipCounter++
    currentIp = `192.0.2.${String(ipCounter)}`
}

describe('HTTP L1 rate limit in the server', () => {
    beforeEach(async () => {
        freshIp()
        await loadServer()
    })

    it('route, API 404 and preflight share one per-IP bucket', async () => {
        expect((await route()).status).toBe('200 OK')
        expect((await notFound()).status).toBe('404 Not Found')
        expect((await preflight()).status).toBe('200 OK')

        for (const request of [route, notFound, preflight]) {
            const response = await request()
            expect(response.status).toBe('429 Too Many Requests')
            expect(header(response, 'retry-after')).toHaveLength(1)
            expect(header(response, 'x-ratelimit-limit')).toEqual(['3'])
        }
    })

    it('counts each request exactly once', async () => {
        await route()
        await route()
        // A double count would have used up the budget of 3 already.
        expect((await route()).status).toBe('200 OK')
        expect((await route()).status).toBe('429 Too Many Requests')
    })

    it('a 429 preflight still carries CORS headers', async () => {
        for (let i = 0; i < 3; i++) await preflight()
        const response = await preflight()
        expect(response.status).toBe('429 Too Many Requests')
        expect(header(response, 'access-control-allow-origin')).toEqual(['https://app.test'])
    })

    it('plain HTTP on the WebSocket path uses the L1 budget', async () => {
        for (let i = 0; i < 3; i++) {
            expect((await call('any /*', '/api/websocket', 'get')).status).toBe('404 Not Found')
        }
        expect((await call('any /*', '/api/websocket', 'post')).status).toBe(
            '429 Too Many Requests',
        )
    })

    it('another IP has its own budget', async () => {
        for (let i = 0; i < 4; i++) await route()
        freshIp()
        expect((await route()).status).toBe('200 OK')
    })
})

describe('L1 coverage with other settings', () => {
    beforeEach(() => {
        freshIp()
    })

    it('follows a changed API_PATH_PREFIX', async () => {
        await loadServer({ pathPrefix: 'v2' })
        for (let i = 0; i < 3; i++) await call('any /*', '/v2/nope', 'get')
        expect((await call('any /*', '/v2/nope', 'get')).status).toBe('429 Too Many Requests')
    })

    it('does not count static files', async () => {
        await loadServer({ serveStatic: true })
        const { staticHandler } = await import('#vendor/start/static-server.js')
        vi.mocked(staticHandler).mockImplementation((res) => {
            ;(res as unknown as { end: () => void }).end()
            return Promise.resolve()
        })
        for (let i = 0; i < 10; i++) await call('any /*', '/assets/app.js', 'get')
        expect(staticHandler).toHaveBeenCalledTimes(10)
        expect((await notFound()).status).toBe('404 Not Found')
    })

    it('counts the doc routes page (manual-test) in L1', async () => {
        await loadServer({ serveStatic: true, docPage: true })
        // The page answers only while the server is listening (initServer sets the socket).
        const doc = () => call('get /api/doc/routes', '/api/doc/routes', 'get')
        for (let i = 0; i < 3; i++) expect((await doc()).status).toBe('200 OK')
        const blocked = await doc()
        expect(blocked.status).toBe('429 Too Many Requests')
        expect(header(blocked, 'retry-after')).toHaveLength(1)
    })
})

// feat-159 (review 2026-11-10): a 404 of the fallback route is an answer a cross-origin SPA has
// to be able to read. Without the CORS headers the browser reports "Failed to fetch" instead.
describe('CORS headers on the 404 of the fallback route', () => {
    beforeEach(async () => {
        freshIp()
        await loadServer()
    })

    it('an unknown API path answers 404 with the allowed origin', async () => {
        const response = await call('any /*', '/api/nope', 'get', ORIGIN)

        expect(response.status).toBe('404 Not Found')
        expect(header(response, 'access-control-allow-origin')).toEqual(['https://app.test'])
    })

    it('an unknown path outside the API answers 404 with the allowed origin too', async () => {
        const response = await call('any /*', '/nope', 'post', ORIGIN)

        expect(response.status).toBe('404 Not Found')
        expect(header(response, 'access-control-allow-origin')).toEqual(['https://app.test'])
    })

    it('an origin that is not allowed gets no allow-origin header', async () => {
        const response = await call('any /*', '/api/nope', 'get', { origin: 'https://evil.test' })

        expect(response.status).toBe('404 Not Found')
        expect(header(response, 'access-control-allow-origin')).toEqual([])
    })

    it('exposes headers as a comma-separated list', async () => {
        const response = await call('any /*', '/api/nope', 'get', ORIGIN)

        const [exposed = ''] = header(response, 'access-control-expose-headers')
        expect(exposed).toContain(', ')
        expect(exposed.split(', ').every((name) => /^[A-Za-z-]+$/.test(name))).toBe(true)
    })
})
