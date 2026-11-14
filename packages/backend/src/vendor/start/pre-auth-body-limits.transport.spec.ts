import { connect, createServer } from 'node:net'

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * feat-202 (security review 2026-11-12, M-3) on a real uWebSockets.js server: what a client
 * can make the server buffer before it is authenticated. A JSON route without a limit of its
 * own takes 100 KB; a route that reads its body only for a signed-in user answers 401 to a
 * request without that cookie before a byte of the body is read.
 */

vi.hoisted(() => {
    process.env['APP_KEY'] ??= 'k'.repeat(16) + '3f9a1c7e5b2d4f60'
})

const getFreePort = () =>
    new Promise<number>((resolve, reject) => {
        const probe = createServer()
        probe.once('error', reject)
        probe.listen(0, '127.0.0.1', () => {
            const address = probe.address()
            probe.close(() => {
                resolve(typeof address === 'object' && address !== null ? address.port : 0)
            })
        })
    })

const PORT = await getFreePort()
const RESPONSE_TIMEOUT_MS = 2_000
const DEFAULT_JSON = 102_400

vi.mock('#config/app.js', async (importOriginal) => {
    const actual = await importOriginal<{ default: Record<string, unknown> }>()
    return {
        default: {
            ...actual.default,
            host: '127.0.0.1',
            port: PORT,
            serveStatic: false,
            unixPath: undefined,
            pathPrefix: 'api',
        },
    }
})
vi.mock('#vendor/utils/middlewares/core/execute-httpMiddlewares.js', () => ({
    default: vi.fn().mockResolvedValue(true),
}))
vi.mock('#vendor/utils/session/session-handler.js', () => ({
    wsSessionHandler: vi.fn(),
}))
vi.mock('#vendor/utils/logger.js', () => {
    const logger = {
        error: vi.fn(),
        warn: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
        child: (): unknown => logger,
    }
    return { default: logger }
})

const handler = vi.fn(() => ({ ok: true }))
const pass = { validate: (input: unknown) => ({ ok: true, value: input }) }
const routes = [
    { method: 'post', url: 'api/pre/json', middlewares: [], validator: pass, handler },
    {
        method: 'post',
        url: 'api/pre/json-large',
        middlewares: [],
        validator: pass,
        maxBodySize: 300_000,
        handler,
    },
    {
        method: 'post',
        url: 'api/pre/upload',
        middlewares: [],
        validator: pass,
        allowedContentTypes: ['multipart'],
        maxBodySize: 1_000_000,
        signedInBeforeBody: true,
        handler,
    },
].map((route) => ({ ...route, responseCheck: null }))

interface RawResponse {
    statusLine: string
    headers: Map<string, string>
    body: string
    closedByServer: boolean
}

const tryParse = (data: Buffer): Omit<RawResponse, 'closedByServer'> | null => {
    const headerEnd = data.indexOf('\r\n\r\n')
    if (headerEnd === -1) return null
    const [statusLine = '', ...lines] = data.subarray(0, headerEnd).toString().split('\r\n')
    const headers = new Map<string, string>()
    for (const line of lines) {
        const colon = line.indexOf(':')
        headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim())
    }
    const length = Number(headers.get('content-length') ?? '0')
    const body = data.subarray(headerEnd + 4)
    if (body.byteLength < length) return null
    return { statusLine, headers, body: body.subarray(0, length).toString() }
}

/** Sends `bytes` as they are and resolves with the first full answer. */
const send = (bytes: string | Buffer): Promise<RawResponse> =>
    new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(`no full response within ${String(RESPONSE_TIMEOUT_MS)} ms`))
        }, RESPONSE_TIMEOUT_MS)
        let data = Buffer.alloc(0)
        let parsed: Omit<RawResponse, 'closedByServer'> | null = null
        const socket = connect(PORT, '127.0.0.1', () => {
            socket.write(bytes)
        })
        const finish = (closedByServer: boolean): void => {
            if (parsed === null) return
            clearTimeout(timer)
            socket.destroy()
            resolve({ ...parsed, closedByServer })
        }
        socket.on('data', (chunk: Buffer) => {
            data = Buffer.concat([data, chunk])
            parsed ??= tryParse(data)
            if (parsed !== null) {
                setTimeout(() => {
                    finish(false)
                }, 150)
            }
        })
        socket.on('end', () => {
            finish(true)
        })
        socket.on('error', reject)
    })

const jsonRequest = (path: string, bytes: number): string => {
    const body = `{"s":"${'a'.repeat(bytes - 8)}"}`
    return (
        `POST ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n` +
        `Content-Length: ${String(body.length)}\r\n\r\n${body}`
    )
}

const BOUNDARY = 'x-boundary'
const multipartBody = Buffer.from(
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\n` +
        `Content-Type: image/png\r\n\r\n${'p'.repeat(2000)}\r\n--${BOUNDARY}--\r\n`,
)
/** The headers of an upload; `declared` is what Content-Length says is coming. */
const uploadHead = (cookie: string | null, declared: number): string =>
    'POST /api/pre/upload HTTP/1.1\r\nHost: 127.0.0.1\r\n' +
    `Content-Type: multipart/form-data; boundary=${BOUNDARY}\r\n` +
    (cookie === null ? '' : `Cookie: ${cookie}\r\n`) +
    `Content-Length: ${String(declared)}\r\n\r\n`

let stopServer: (type?: string) => Promise<void>
let bodyBytesInFlight: (ipKey?: string) => number
let cookieName = ''
let signedIn = ''
let storedAnonymous = ''

beforeAll(async () => {
    const wsHandlers = await import('#vendor/utils/network/ws-handlers.js')
    wsHandlers.registerWsAppHooks({
        onUpgrade: () => Promise.resolve({ kind: 'missing' as const }),
        onConnected: () => Promise.resolve(),
        onDisconnected: () => Promise.resolve(),
    })
    ;({ bodyBytesInFlight } = await import('#vendor/utils/network/body-budget.js'))
    const { createSignedToken } = await import('#vendor/utils/session/token-handler.js')
    const { ANON_SESSION_NAMESPACE } = await import('#vendor/utils/session/session-ttl.js')
    const { default: sessionConfig } = await import('#config/session.js')
    cookieName = sessionConfig.cookieName
    signedIn = createSignedToken('user-token-1.session-1')
    storedAnonymous = createSignedToken(`${ANON_SESSION_NAMESPACE}.session-2`)

    const server = await import('./server.js')
    stopServer = server.stopServer
    await server.initServer({
        httpRoutes: routes,
        wsRoutesByUrl: new Map(),
        sourceHttpRoutes: [],
        sourceWsRoutes: [],
    } as never)
})

beforeEach(() => {
    handler.mockClear()
})

afterAll(async () => {
    await stopServer('test')
})

describe('the default JSON limit on a real uWS server', () => {
    it('a route without a limit of its own takes 100 KB and refuses more with 413', async () => {
        const atLimit = await send(jsonRequest('/api/pre/json', DEFAULT_JSON))
        const over = await send(jsonRequest('/api/pre/json', DEFAULT_JSON + 1))

        expect(atLimit.statusLine).toBe('HTTP/1.1 200 OK')
        expect(over.statusLine).toBe('HTTP/1.1 413 Payload Too Large')
        expect(JSON.parse(over.body)).toMatchObject({
            code: 'payload_too_large',
            details: { limit: DEFAULT_JSON },
        })
        expect(handler).toHaveBeenCalledTimes(1)
    })

    it('a route that asks for more takes it', async () => {
        const response = await send(jsonRequest('/api/pre/json-large', 150_000))

        expect(response.statusLine).toBe('HTTP/1.1 200 OK')
        expect(handler).toHaveBeenCalledTimes(1)
    })
})

describe('a body read only for a signed-in user, on a real uWS server', () => {
    it.each([
        ['no cookie at all', () => null],
        [
            'a made-up cookie',
            () => `${cookieName}=${Buffer.from('u.s.' + 'a'.repeat(32)).toString('base64')}`,
        ],
        ['the cookie of a stored anonymous session', () => `${cookieName}=${storedAnonymous}`],
    ])(
        '%s: 401 from the headers alone, the connection closed, nothing buffered',
        async (_l, cookie) => {
            // Only the headers are sent: a megabyte is announced and never arrives.
            const response = await send(uploadHead(cookie(), 900_000))

            expect(response.statusLine).toBe('HTTP/1.1 401 Unauthorized')
            expect(JSON.parse(response.body)).toMatchObject({
                status: 'error',
                code: 'unauthorized',
            })
            expect(response.headers.get('connection')).toBe('close')
            expect(response.closedByServer).toBe(true)
            expect(handler).not.toHaveBeenCalled()
            expect(bodyBytesInFlight()).toBe(0)
        },
    )

    it('a body that does arrive without the cookie is not read either', async () => {
        const response = await send(
            Buffer.concat([Buffer.from(uploadHead(null, multipartBody.byteLength)), multipartBody]),
        )

        expect(response.statusLine).toBe('HTTP/1.1 401 Unauthorized')
        expect(handler).not.toHaveBeenCalled()
        expect(bodyBytesInFlight()).toBe(0)
    })

    it('the cookie of a signed-in session: the body is read and the request goes on', async () => {
        const response = await send(
            Buffer.concat([
                Buffer.from(uploadHead(`${cookieName}=${signedIn}`, multipartBody.byteLength)),
                multipartBody,
            ]),
        )

        expect(response.statusLine).toBe('HTTP/1.1 200 OK')
        expect(handler).toHaveBeenCalledTimes(1)
    })
})
