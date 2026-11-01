import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import {
    exchange,
    getFreePort,
    multipartBody,
    type RawResponse,
} from '../../test-support/raw-http.js'

/**
 * feat-063: a route can set its own `maxBodySize`, on top of the global per-kind limit
 * (the smaller of the two wins). Real uWebSockets.js server and raw sockets: what a
 * client that sends too much actually receives, and how much of it the server reads.
 */

const PORT = await getFreePort()
const GLOBAL_MULTIPART_LIMIT = 20_000
const SMALL_ROUTE_LIMIT = 1_000

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
            maxMultipartBodySize: GLOBAL_MULTIPART_LIMIT,
        },
    }
})
vi.mock('#vendor/utils/middlewares/core/execute-httpMiddlewares.js', () => ({
    default: vi.fn().mockResolvedValue(true),
}))
vi.mock('#vendor/utils/session/session-handler.js', () => ({
    wsSessionHandler: vi.fn(),
}))

const handler = vi.fn(
    (context: { httpData: { files: Map<string, { data: Uint8Array }> | null } }) => ({
        ok: true,
        fileBytes: context.httpData.files?.get('file')?.data.byteLength ?? null,
    }),
)

const route = (url: string, maxBodySize?: number) => ({
    method: 'post',
    url: `api/limits/${url}`,
    middlewares: [],
    validator: { validate: (input: unknown) => ({ ok: true, value: input }) },
    allowedContentTypes: ['multipart'],
    parametersKey: [],
    responseCheck: null,
    ...(maxBodySize !== undefined ? { maxBodySize } : {}),
    handler,
})

const routes = [
    route('small', SMALL_ROUTE_LIMIT),
    // Bigger than the global limit: the smaller of the two applies.
    route('above-global', GLOBAL_MULTIPART_LIMIT * 5),
    route('none'),
]

let stopServer: (type?: string) => Promise<void>

beforeAll(async () => {
    const wsHandlers = await import('#vendor/utils/network/ws-handlers.js')
    wsHandlers.registerWsAppHooks({
        onUpgrade: () => Promise.resolve({ kind: 'missing' as const }),
        onConnected: () => Promise.resolve(),
        onDisconnected: () => Promise.resolve(),
        onRefreshToken: () => Promise.resolve(),
        onRevokeToken: () => Promise.resolve(),
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

const post = (url: string, fileBytes: number): Promise<RawResponse> => {
    const { body, contentType } = multipartBody(fileBytes)
    return exchange(PORT, (socket) => {
        socket.write(
            `POST /api/limits/${url} HTTP/1.1\r\nHost: 127.0.0.1\r\n` +
                `Content-Type: ${contentType}\r\nContent-Length: ${String(body.byteLength)}\r\n\r\n`,
        )
        socket.write(body)
    })
}

const expect413 = (response: RawResponse, limit: number): void => {
    expect(response.statusLine).toBe('HTTP/1.1 413 Payload Too Large')
    expect(JSON.parse(response.body)).toMatchObject({
        code: 'payload_too_large',
        details: { limit },
    })
}

describe('a route maxBodySize on a real uWS server', () => {
    it('answers 413 to an oversized Content-Length when only the headers were sent', async () => {
        handler.mockClear()

        const response = await exchange(PORT, (socket) => {
            socket.write(
                'POST /api/limits/small HTTP/1.1\r\nHost: 127.0.0.1\r\n' +
                    'Content-Type: multipart/form-data; boundary=x\r\n' +
                    `Content-Length: ${String(SMALL_ROUTE_LIMIT * 50)}\r\n\r\n`,
            )
        })

        expect413(response, SMALL_ROUTE_LIMIT)
        expect(handler).not.toHaveBeenCalled()
    })

    it('answers 413 mid-stream when a chunk of a chunked body passes the limit, without the end of the body', async () => {
        handler.mockClear()

        const response = await exchange(PORT, (socket) => {
            const chunk = 'a'.repeat(SMALL_ROUTE_LIMIT * 2)
            socket.write(
                'POST /api/limits/small HTTP/1.1\r\nHost: 127.0.0.1\r\n' +
                    'Content-Type: multipart/form-data; boundary=x\r\n' +
                    'Transfer-Encoding: chunked\r\n\r\n' +
                    `${chunk.length.toString(16)}\r\n${chunk}\r\n`,
            )
            // No terminating "0\r\n\r\n": the body is never finished.
        })

        expect413(response, SMALL_ROUTE_LIMIT)
        expect(handler).not.toHaveBeenCalled()
    })

    it('lets a body of exactly the route limit through, and refuses one byte more', async () => {
        handler.mockClear()
        // The multipart framing around the file is a fixed number of bytes.
        const framing = multipartBody(0).body.byteLength

        const atLimit = await post('small', SMALL_ROUTE_LIMIT - framing)
        expect(atLimit.statusLine).toBe('HTTP/1.1 200 OK')
        expect(JSON.parse(atLimit.body)).toMatchObject({ fileBytes: SMALL_ROUTE_LIMIT - framing })

        const over = await post('small', SMALL_ROUTE_LIMIT - framing + 1)
        expect413(over, SMALL_ROUTE_LIMIT)
        expect(handler).toHaveBeenCalledTimes(1)
    })

    it('applies the global limit when the route asks for more', async () => {
        handler.mockClear()
        const framing = multipartBody(0).body.byteLength

        const over = await post('above-global', GLOBAL_MULTIPART_LIMIT - framing + 1)

        expect413(over, GLOBAL_MULTIPART_LIMIT)
        expect(handler).not.toHaveBeenCalled()
    })

    it('keeps the global limit for a route without its own', async () => {
        handler.mockClear()
        const framing = multipartBody(0).body.byteLength

        const atLimit = await post('none', GLOBAL_MULTIPART_LIMIT - framing)
        const over = await post('none', GLOBAL_MULTIPART_LIMIT - framing + 1)

        expect(atLimit.statusLine).toBe('HTTP/1.1 200 OK')
        expect413(over, GLOBAL_MULTIPART_LIMIT)
    })
})
