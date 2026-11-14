import { type } from '@arktype/type'
import type * as uWS from 'uWebSockets.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { defineRawRoute } from '#app/routing/define-raw-route.js'
import type { HttpContext } from '#vendor/types/types.js'

// Regression tests for findings marked "closed, no test" in
// docs/security/security-analysis-status.md. Each describe names its finding id.
// Requests go through the handlers registered with uWS, like the other server specs.

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

vi.mock('uWebSockets.js', async (importOriginal) => {
    const actual = await importOriginal<typeof uWS>()
    return {
        App: () => fakeApp,
        us_listen_socket_close: vi.fn(),
        // Real multipart parser, so M-2 covers multipart bodies too.
        getParts: actual.getParts,
    }
})

vi.mock('#config/cors.js', async (importOriginal) => {
    const actual = await importOriginal<{ default: Record<string, unknown> }>()
    return {
        default: {
            ...actual.default,
            enabled: true,
            credentials: true,
            allowedOrigins: ['https://app.test'],
        },
    }
})

vi.mock('#app/routes/http-routes.js', () => ({ default: [] }))
vi.mock('#app/routes/ws-routes.js', () => ({ default: [] }))
vi.mock('#vendor/utils/network/get-ip.js', () => ({
    default: () => '127.0.0.1',
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
        httpGlobal: { windowMs: 60_000, max: 10_000 },
        wsUpgrade: { windowMs: 60_000, max: 10_000 },
        configError: null,
    },
}))

const received: unknown[] = []
const controller = vi.fn((context: HttpContext) => {
    received.push(context.httpData.payload)
    return { status: 'success' }
})
const SECRET_DETAIL = 'connect ECONNREFUSED db.internal:5432 password=hunter2'
const failing = vi.fn(() => {
    throw new Error(SECRET_DETAIL)
})

const NameSchema = type({ name: 'string' })

const routes = [
    {
        ...defineRawRoute({
            url: 'json',
            method: 'post',
            validator: NameSchema,
            handler: controller,
        }),
    },
    {
        ...defineRawRoute({
            url: 'form',
            method: 'post',
            validator: NameSchema,
            allowedContentTypes: ['urlencoded', 'multipart'],
            handler: controller,
        }),
    },
    { ...defineRawRoute({ url: 'item', method: 'del', handler: controller }) },
    { ...defineRawRoute({ url: 'boom', method: 'get', handler: failing }) },
].map((route) => ({ ...route, url: `api/${route.url}`, middlewares: [] }))

interface Captured {
    status: string
    headers: { name: string; value: string }[]
    body: string
}

const loadServer = async (app: Record<string, unknown> = {}) => {
    vi.resetModules()
    handlers.clear()
    vi.doMock('#config/app.js', async (importOriginal) => {
        const actual = await importOriginal<{ default: Record<string, unknown> }>()
        return {
            default: {
                ...actual.default,
                serveStatic: false,
                unixPath: undefined,
                pathPrefix: 'api',
                ...app,
            },
        }
    })
    const { initServer } = await import('./server.js')
    await initServer({
        httpRoutes: routes.map((route) => ({ ...route, responseCheck: null })),
        wsRoutesByUrl: new Map(),
        sourceHttpRoutes: [],
        sourceWsRoutes: [],
    } as never)
}

const call = async (
    key: string,
    url: string,
    method: string,
    headers: Record<string, string> = {},
    body = '',
): Promise<Captured> => {
    const handler = handlers.get(key)
    if (handler === undefined) throw new Error(`No handler registered for ${key}`)
    const captured: Captured = { status: '', headers: [], body: '' }
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
        onData: (callback: (chunk: ArrayBuffer, isLast: boolean) => void) => {
            const bytes = new TextEncoder().encode(body)
            callback(
                bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
                true,
            )
            return res
        },
        writeStatus: (status: string) => {
            captured.status = status
            return res
        },
        writeHeader: (name: string, value: string) => {
            captured.headers.push({ name, value })
            return res
        },
        end: (chunk?: string) => {
            captured.body = chunk ?? ''
            done()
            return res
        },
        close: () => {
            done()
            return res
        },
    }
    const req = {
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
    }
    await handler(res, req)
    await finished
    return captured
}

const header = (response: Captured, name: string) =>
    response.headers.filter((item) => item.name.toLowerCase() === name).map((item) => item.value)

const post = (url: string, contentType: string, body: string, contentLength?: string) =>
    call(
        `post /api/${url}`,
        `/api/${url}`,
        'post',
        {
            'content-type': contentType,
            'content-length': contentLength ?? String(new TextEncoder().encode(body).length),
        },
        body,
    )

beforeEach(() => {
    controller.mockClear()
    received.length = 0
})

describe('C-1: CORS allows only listed origins', () => {
    beforeEach(async () => {
        await loadServer()
    })

    it('a preflight from an origin outside the list gets no CORS grant', async () => {
        const response = await call('any /*', '/api/json', 'options', {
            origin: 'https://evil.test',
        })
        expect(header(response, 'access-control-allow-origin')).toEqual([])
        expect(header(response, 'access-control-allow-credentials')).toEqual([])
        expect(header(response, 'vary')).toEqual(['Origin'])
    })

    it('never answers with a wildcard, even for a listed origin', async () => {
        const response = await call('any /*', '/api/json', 'options', {
            origin: 'https://app.test',
        })
        expect(header(response, 'access-control-allow-origin')).toEqual(['https://app.test'])
        expect(header(response, 'access-control-allow-credentials')).toEqual(['true'])
    })

    it('a route response to a foreign origin carries no CORS grant', async () => {
        const body = JSON.stringify({ name: 'x' })
        const response = await call(
            'post /api/json',
            '/api/json',
            'post',
            {
                origin: 'https://evil.test',
                'content-type': 'application/json',
                'content-length': String(body.length),
            },
            body,
        )
        expect(response.status).toBe('200 OK')
        expect(header(response, 'access-control-allow-origin')).toEqual([])
    })
})

describe('H-1: exception details only in the local env', () => {
    it.each(['production', 'manual-test', 'test'])('hides the error in %s', async (env) => {
        await loadServer({ env })
        const response = await call('get /api/boom', '/api/boom', 'get')
        expect(response.status).toBe('500 Internal Server Error')
        expect(response.body).not.toContain('hunter2')
        expect(JSON.parse(response.body)).toMatchObject({
            code: 'internal_error',
            message: 'Internal server error',
        })
    })

    it('shows the error in local', async () => {
        await loadServer({ env: 'local' })
        const response = await call('get /api/boom', '/api/boom', 'get')
        expect(response.status).toBe('500 Internal Server Error')
        expect(JSON.parse(response.body)).toMatchObject({ message: `Error: ${SECRET_DETAIL}` })
    })
})

describe('M-2: validation runs for every body kind', () => {
    beforeEach(async () => {
        await loadServer()
    })

    it('rejects an invalid urlencoded body with 422', async () => {
        const response = await post('form', 'application/x-www-form-urlencoded', 'other=1')
        expect(response.status).toBe('422 Unprocessable Entity')
        expect(controller).not.toHaveBeenCalled()
    })

    it('passes a valid urlencoded body', async () => {
        const response = await post('form', 'application/x-www-form-urlencoded', 'name=box')
        expect(response.status).toBe('200 OK')
        expect(received).toEqual([{ name: 'box' }])
    })

    it('rejects an invalid multipart body with 422', async () => {
        const body = [
            '--XB',
            'Content-Disposition: form-data; name="other"',
            '',
            '1',
            '--XB--',
            '',
        ].join('\r\n')
        const response = await post('form', 'multipart/form-data; boundary=XB', body)
        expect(response.status).toBe('422 Unprocessable Entity')
        expect(controller).not.toHaveBeenCalled()
    })
})

describe('M-3: content types not allowed by the route get 415', () => {
    beforeEach(async () => {
        await loadServer()
    })

    it.each([
        ['application/octet-stream', 'abc'],
        ['text/plain', 'name=box'],
        ['application/x-www-form-urlencoded', 'name=box'],
        ['multipart/form-data; boundary=XB', '--XB--\r\n'],
    ])('rejects %s on a JSON route', async (contentType, body) => {
        const response = await post('json', contentType, body)
        expect(response.status).toBe('415 Unsupported Media Type')
        expect(controller).not.toHaveBeenCalled()
    })

    it('rejects JSON on a route that allows only forms', async () => {
        const response = await post('form', 'application/json', '{"name":"box"}')
        expect(response.status).toBe('415 Unsupported Media Type')
        expect(controller).not.toHaveBeenCalled()
    })
})

describe('M-4: Content-Length is read only when it is all digits', () => {
    beforeEach(async () => {
        await loadServer()
    })

    // Number() would read these as huge sizes and answer 413 before reading the body.
    it.each(['1e9', '0x7fffffff', '9e999'])(
        'does not reject early on Content-Length %j',
        async (contentLength) => {
            const response = await post('json', 'application/json', '{"name":"box"}', contentLength)
            expect(response.status).not.toBe('413 Payload Too Large')
        },
    )

    it('still rejects an all-digit Content-Length over the limit', async () => {
        const response = await post('json', 'application/json', '{}', '999999999999')
        expect(response.status).toBe('413 Payload Too Large')
    })
})

describe('L-1: DELETE routes are registered', () => {
    it('registers a del route with uWS and serves it', async () => {
        await loadServer()
        expect(handlers.has('del /api/item')).toBe(true)
        const response = await call('del /api/item', '/api/item', 'del')
        expect(response.status).toBe('200 OK')
        expect(controller).toHaveBeenCalledTimes(1)
    })
})

describe('L-2: the routes doc page exists only in manual-test', () => {
    it.each([
        { env: 'production', docPage: true, serveStatic: true },
        { env: 'local', docPage: true, serveStatic: true },
        { env: 'manual-test', docPage: false, serveStatic: true },
        { env: 'manual-test', docPage: true, serveStatic: false },
    ])('is not registered with %o', async (app) => {
        await loadServer(app)
        expect(handlers.has('get /api/doc/routes')).toBe(false)
        const response = await call('any /*', '/api/doc/routes', 'get')
        expect(response.status).toBe('404 Not Found')
    })
})

describe('L-3: no info log of the whole request data', () => {
    it('the "Get Http Data" log is gone from the source', async () => {
        const { readdir, readFile } = await import('node:fs/promises')
        const path = await import('node:path')
        const root = path.resolve(import.meta.dirname, '../..')
        const files = (await readdir(root, { recursive: true }))
            .filter((file) => file.endsWith('.ts') && !file.endsWith('.spec.ts'))
            .map((file) => path.join(root, file))
        const hits: string[] = []
        for (const file of files) {
            if ((await readFile(file, 'utf8')).includes('Get Http Data')) hits.push(file)
        }
        expect(files.length).toBeGreaterThan(50)
        expect(hits).toEqual([])
    })
})
