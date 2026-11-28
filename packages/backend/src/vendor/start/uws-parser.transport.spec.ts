import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import {
    exchange,
    exchangeUntilClose,
    getFreePort,
    type ClosedExchange,
} from '../../test-support/raw-http.js'

/**
 * feat-277: what uWebSockets.js (v20.72.0, core v20.81.0) refuses by itself, and what the
 * new string writer sends, on a real server with our routes. Raw sockets, so the exact
 * bytes go out. Two classes of refusal (documentation/backend/request-lifecycle.md; the
 * bare-uWS side is pinned in uws-native.transport.spec.ts):
 * 1. request target and Host: uWS answers 400 before any handler runs;
 * 2. found while reading the body (Content-Length of 2^56+, trailers): our handler has
 *    already been called, the client still gets uWS's 400 and the connection closes.
 */

const PORT = await getFreePort()
const ALLOWED_ORIGIN = 'https://app.example.test'

const cors = vi.hoisted(() => ({ enabled: false }))

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
vi.mock('#config/cors.js', async (importOriginal) => {
    const actual = await importOriginal<{ default: Record<string, unknown> }>()
    return {
        default: {
            ...actual.default,
            allowedOrigins: [ALLOWED_ORIGIN],
            get enabled() {
                return cors.enabled
            },
        },
    }
})
vi.mock('#vendor/utils/middlewares/core/execute-httpMiddlewares.js', () => ({
    default: vi.fn().mockResolvedValue(true),
}))
vi.mock('#vendor/utils/session/session-handler.js', () => ({
    wsSessionHandler: vi.fn(),
}))

// Cyrillic (2 bytes), CJK (3 bytes), emoji (4 bytes, a surrogate pair in JS), a combining mark.
const MIXED = 'Привіт, світе! 你好 😀🚀👩‍💻 é '
// Longer than any string pool: the writer measures first and writes in more than one go.
const LONG = MIXED.repeat(40_000)

const echo = vi.fn((context: { httpData: { payload: unknown } }) => ({
    ok: true,
    payload: context.httpData.payload,
}))
const text = vi.fn((context: { httpData: { params: Record<string, string> } }) => {
    const kind = context.httpData.params['kind']
    return { text: kind === 'long' ? LONG : kind === 'empty' ? '' : MIXED }
})

const route = (method: string, url: string, handler: unknown, extra: object = {}) => ({
    method,
    url: `api/${url}`,
    middlewares: [],
    validator: { validate: (input: unknown) => ({ ok: true, value: input }) },
    parametersKey: [],
    responseCheck: null,
    handler,
    ...extra,
})

const routes = [
    route('post', 'parser/echo', echo, { allowedContentTypes: ['json'] }),
    route('get', 'parser/text/:kind', text, { parametersKey: ['kind'] }),
]

let stopServer: (type?: string) => Promise<void>
let loggerError: ReturnType<typeof vi.spyOn>

beforeAll(async () => {
    const logger = (await import('#vendor/utils/logger.js')).default
    loggerError = vi.spyOn(logger, 'error')
    const wsHandlers = await import('#vendor/utils/network/ws-handlers.js')
    wsHandlers.registerWsAppHooks({
        onUpgrade: () => Promise.resolve({ kind: 'missing' as const }),
        onConnected: () => Promise.resolve(),
        onDisconnected: () => Promise.resolve(),
    })
    const server = await import('./server.js')
    stopServer = server.stopServer
    await server.initServer({
        httpRoutes: routes,
        wsRoutesByUrl: new Map(),
        sourceHttpRoutes: [],
        sourceWsRoutes: [],
    } as never)
})

afterAll(async () => {
    await stopServer('test')
})

beforeEach(() => {
    echo.mockClear()
    text.mockClear()
    loggerError.mockClear()
    cors.enabled = false
})

const UWS_400 = 'HTTP/1.1 400 Bad Request'

/** A class-1 refusal: uWS's own 400, the server closes the connection, no handler ran. */
const expectParserRefusal = (result: ClosedExchange): void => {
    expect(result.response?.statusLine).toBe(UWS_400)
    expect(result.response?.headers.get('connection')).toBe('close')
    expect(result.closedByServer).toBe(true)
}

const sendRaw = (head: string | Buffer): Promise<ClosedExchange> =>
    exchangeUntilClose(PORT, (socket) => {
        socket.write(head)
    })

describe('uWS refuses the request line and headers itself (class 1)', () => {
    it('answers 400 to raw UTF-8 in the request target and closes', async () => {
        const result = await sendRaw(
            Buffer.concat([
                Buffer.from('GET /api/parser/text/'),
                Buffer.from('привіт', 'utf8'),
                Buffer.from(' HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n'),
            ]),
        )

        expectParserRefusal(result)
        expect(text).not.toHaveBeenCalled()
    })

    it('lets a percent-encoded target through to the router', async () => {
        const response = await exchange(PORT, (socket) => {
            socket.write('GET /api/%D0%BF HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n')
        })

        expect(response.statusLine).toBe('HTTP/1.1 404 Not Found')
        expect(JSON.parse(response.body)).toMatchObject({ code: 'not_found' })
    })

    it.each(['127.0.0.1/path', '127.0.0.1?q', '127.0.0.1#f'])(
        'answers 400 to Host: %s and closes',
        async (host) => {
            const result = await sendRaw(`GET /api/parser/text/a HTTP/1.1\r\nHost: ${host}\r\n\r\n`)

            expectParserRefusal(result)
            expect(text).not.toHaveBeenCalled()
        },
    )
})

describe('a Content-Length of 2^56 or more (uWebSockets #1969, class 2)', () => {
    it('gets uWS 400 and a close; our body limit keeps the controller from running', async () => {
        const result = await sendRaw(
            'POST /api/parser/echo HTTP/1.1\r\nHost: 127.0.0.1\r\n' +
                'Content-Type: application/json\r\nContent-Length: 72057594037927936\r\n\r\n{}',
        )

        expectParserRefusal(result)
        expect(echo).not.toHaveBeenCalled()
        await new Promise((resolve) => setTimeout(resolve, 50))
        expect(loggerError).not.toHaveBeenCalled()
    })
})

const chunkedHead =
    'POST /api/parser/echo HTTP/1.1\r\nHost: 127.0.0.1\r\n' +
    'Content-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n'
const BODY = '{"a":1}'
const firstChunk = `${BODY.length.toString(16)}\r\n${BODY}\r\n`

describe('trailers after the last chunk (uWebSockets #1950)', () => {
    it('accepts a well-formed trailer', async () => {
        const response = await exchange(PORT, (socket) => {
            socket.write(`${chunkedHead}${firstChunk}0\r\nX-Trailer: y\r\n\r\n`)
        })

        expect(response.statusLine).toBe('HTTP/1.1 200 OK')
        expect(echo).toHaveBeenCalledTimes(1)
    })

    it('answers 400 to a trailer with a bare LF sent with the body (class 2, one packet)', async () => {
        const result = await sendRaw(`${chunkedHead}${firstChunk}0\r\nX-Trailer: y\n\r\n`)

        expectParserRefusal(result)
        await new Promise((resolve) => setTimeout(resolve, 50))
        expect(loggerError).not.toHaveBeenCalled()
    })

    it('answers 400 to a bare-LF trailer that comes after the body: the handler has already run (class 2)', async () => {
        const result = await exchangeUntilClose(PORT, (socket) => {
            socket.write(`${chunkedHead}${firstChunk}`)
            setTimeout(() => socket.write('0\r\nX-Trailer: y\n\r\n'), 100)
        })

        expect(result.response?.statusLine).toBe(UWS_400)
        expect(result.closedByServer).toBe(true)
        // The body ended (last = true) before uWS parsed the trailer.
        expect(echo).toHaveBeenCalledTimes(1)
        // Our answer to the gone request is dropped quietly; the server keeps serving.
        await new Promise((resolve) => setTimeout(resolve, 50))
        expect(loggerError).not.toHaveBeenCalled()
        const next = await exchange(PORT, (socket) => {
            socket.write('GET /api/parser/text/a HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n')
        })
        expect(next.statusLine).toBe('HTTP/1.1 200 OK')
    })
})

describe('OPTIONS * (uWebSockets #1952) reaches the catch-all route', () => {
    const optionsStar = (origin?: string) =>
        exchange(PORT, (socket) => {
            socket.write(
                'OPTIONS * HTTP/1.1\r\nHost: 127.0.0.1\r\n' +
                    (origin !== undefined ? `Origin: ${origin}\r\n` : '') +
                    '\r\n',
            )
        })

    it('answers 404 not_found with CORS off', async () => {
        const response = await optionsStar(ALLOWED_ORIGIN)

        expect(response.statusLine).toBe('HTTP/1.1 404 Not Found')
        expect(JSON.parse(response.body)).toMatchObject({ code: 'not_found' })
    })

    it('answers 200 with the CORS headers for an allowed Origin', async () => {
        cors.enabled = true

        const response = await optionsStar(ALLOWED_ORIGIN)

        expect(response.statusLine).toBe('HTTP/1.1 200 OK')
        expect(response.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN)
        expect(response.headers.get('access-control-allow-methods')).toBeTruthy()
        expect(response.headers.get('access-control-allow-headers')).toBeTruthy()
        expect(response.headers.get('vary')).toBe('Origin')
    })

    it('answers 200 with Vary only for a foreign Origin', async () => {
        cors.enabled = true

        const response = await optionsStar('https://evil.example.test')

        expect(response.statusLine).toBe('HTTP/1.1 200 OK')
        expect(response.headers.get('vary')).toBe('Origin')
        expect(
            [...response.headers.keys()].some((name) => name.startsWith('access-control-')),
        ).toBe(false)
    })
})

describe('outgoing UTF-8 (the new string writer, uWebSockets.js #1335–#1354)', () => {
    it.each([
        ['mixed', MIXED],
        ['long', LONG],
        ['empty', ''],
    ])('sends the %s text byte for byte, with Content-Length in bytes', async (kind, expected) => {
        const response = await exchange(
            PORT,
            (socket) => {
                socket.write(`GET /api/parser/text/${kind} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`)
            },
            10_000,
        )

        expect(response.statusLine).toBe('HTTP/1.1 200 OK')
        expect(Number(response.headers.get('content-length'))).toBe(response.bodyBytes.byteLength)
        const body = JSON.parse(response.bodyBytes.toString('utf8')) as Record<string, unknown>
        expect(body).toMatchObject({ text: expected })
        // What the server sent is exactly the UTF-8 of what it serialized.
        expect(response.bodyBytes.equals(Buffer.from(JSON.stringify(body), 'utf8'))).toBe(true)
    })
})
