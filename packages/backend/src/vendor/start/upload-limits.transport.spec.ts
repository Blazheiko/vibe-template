import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import {
    AVATAR_MAX_FILE_BYTES,
    KB_SCREENSHOT_MAX_FILE_BYTES,
    MULTIPART_OVERHEAD_BYTES,
    multipartBodyLimit,
} from '#app/services/shared/upload-limits.js'
import {
    exchange,
    getFreePort,
    multipartBody,
    streamUntilAnswered,
    type RawResponse,
    type StreamResult,
} from '../../test-support/raw-http.js'

/**
 * feat-063: the avatar and knowledge-base upload limits, with the real sizes, on a real
 * uWebSockets.js server. Before, the body limit of a multipart route was the global
 * 50 MiB, so a 10 MiB avatar limit was only checked after 50 MiB had been read.
 */

const PORT = await getFreePort()
const MIB = 1024 * 1024
const AVATAR_BODY_LIMIT = multipartBodyLimit(AVATAR_MAX_FILE_BYTES)

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
            // The shipped default: the limit the routes below must tighten.
            maxMultipartBodySize: 50 * 1024 * 1024,
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

const route = (url: string, maxBodySize: number) => ({
    method: 'post',
    url: `api/${url}`,
    middlewares: [],
    validator: { validate: (input: unknown) => ({ ok: true, value: input }) },
    allowedContentTypes: ['multipart'],
    parametersKey: [],
    responseCheck: null,
    maxBodySize,
    handler,
})

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
        httpRoutes: [
            route('avatar/upload', AVATAR_BODY_LIMIT),
            route('screenshot', multipartBodyLimit(KB_SCREENSHOT_MAX_FILE_BYTES)),
        ],
        wsRoutesByUrl: new Map(),
        sourceHttpRoutes: [],
        sourceWsRoutes: [],
    } as never)
})

afterAll(async () => {
    await stopServer('test')
})

// An oversized body is refused either with a 413 the client reads, or by closing the
// connection while the client is still sending (the reset may beat the answer).
const expectRefused = (result: StreamResult): void => {
    if (result.response === null) {
        expect(result.reset).toBe(true)
    } else {
        expect(result.response.statusLine).toBe('HTTP/1.1 413 Payload Too Large')
    }
}

const upload = (path: string, fileBytes: number): Promise<RawResponse> => {
    const { body, contentType } = multipartBody(fileBytes)
    return exchange(
        PORT,
        (socket) => {
            socket.write(
                `POST ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: ${contentType}\r\n` +
                    `Content-Length: ${String(body.byteLength)}\r\n\r\n`,
            )
            socket.write(body)
        },
        15_000,
    )
}

describe('avatar upload body limit (10 MiB file + framing)', () => {
    it('accepts a file of exactly 10 MiB: its framing fits in the body limit', async () => {
        handler.mockClear()
        expect(multipartBody(AVATAR_MAX_FILE_BYTES).body.byteLength).toBeLessThanOrEqual(
            AVATAR_BODY_LIMIT,
        )

        const response = await upload('/api/avatar/upload', AVATAR_MAX_FILE_BYTES)

        expect(response.statusLine).toBe('HTTP/1.1 200 OK')
        expect(JSON.parse(response.body)).toMatchObject({ fileBytes: AVATAR_MAX_FILE_BYTES })
    })

    it('answers 413 when the whole body is one byte over the limit', async () => {
        handler.mockClear()
        const framing = multipartBody(0).body.byteLength

        const over = await upload('/api/avatar/upload', AVATAR_BODY_LIMIT - framing + 1)

        expect(over.statusLine).toBe('HTTP/1.1 413 Payload Too Large')
        expect(JSON.parse(over.body)).toMatchObject({ details: { limit: AVATAR_BODY_LIMIT } })
        expect(handler).not.toHaveBeenCalled()
    })

    it('answers 413 to an 11 MiB Content-Length when only the headers were sent', async () => {
        handler.mockClear()

        const response = await exchange(PORT, (socket) => {
            socket.write(
                'POST /api/avatar/upload HTTP/1.1\r\nHost: 127.0.0.1\r\n' +
                    'Content-Type: multipart/form-data; boundary=x\r\n' +
                    `Content-Length: ${String(11 * MIB)}\r\n\r\n`,
            )
        })

        expect(response.statusLine).toBe('HTTP/1.1 413 Payload Too Large')
        expect(handler).not.toHaveBeenCalled()
    })

    it('answers 413 to a chunked 50 MiB body long before it ends, having read about the limit', async () => {
        handler.mockClear()

        const result = await streamUntilAnswered(
            PORT,
            '/api/avatar/upload',
            'multipart/form-data; boundary=x',
            50 * MIB,
        )
        const { bytesWritten } = result

        expectRefused(result)
        // The server stopped reading near the 10 MiB limit, not at the global 50 MiB (the
        // client may be a few buffered chunks ahead of the answer).
        expect(bytesWritten).toBeGreaterThan(AVATAR_MAX_FILE_BYTES)
        expect(bytesWritten).toBeLessThan(AVATAR_BODY_LIMIT + 8 * MIB)
        expect(handler).not.toHaveBeenCalled()
    })

    it('does not buffer 20 parallel 50 MiB uploads: every one is refused near the limit', async () => {
        handler.mockClear()
        const rssBefore = process.memoryUsage().rss

        const results = await Promise.all(
            Array.from({ length: 20 }, () =>
                streamUntilAnswered(
                    PORT,
                    '/api/avatar/upload',
                    'multipart/form-data; boundary=x',
                    50 * MIB,
                ),
            ),
        )

        for (const result of results) {
            const { bytesWritten } = result
            expectRefused(result)
            // Without the route limit the answer came only after the global 50 MiB. Here it
            // arrives well before that; the rest is what the socket buffers already held
            // (20 clients write much faster than the server answers).
            expect(bytesWritten).toBeLessThan(40 * MIB)
        }
        expect(handler).not.toHaveBeenCalled()
        // 20 x 50 MiB held in memory would be a gigabyte; here at most the limit each.
        const grownMib = (process.memoryUsage().rss - rssBefore) / MIB
        expect(grownMib).toBeLessThan(20 * 12)
    })
})

describe('knowledge-base screenshot body limit (5 MiB file + framing)', () => {
    it('accepts a file of exactly 5 MiB and refuses a body over the limit', async () => {
        handler.mockClear()
        const framing = multipartBody(0).body.byteLength
        const limit = multipartBodyLimit(KB_SCREENSHOT_MAX_FILE_BYTES)

        const atLimit = await upload('/api/screenshot', KB_SCREENSHOT_MAX_FILE_BYTES)
        const over = await upload('/api/screenshot', limit - framing + 1)

        expect(atLimit.statusLine).toBe('HTTP/1.1 200 OK')
        expect(over.statusLine).toBe('HTTP/1.1 413 Payload Too Large')
        expect(JSON.parse(over.body)).toMatchObject({ details: { limit } })
    })
})

describe('the overhead allowance', () => {
    it('is large enough for realistic multipart framing', () => {
        // Boundary lines, part headers, a long filename and a few small text fields.
        const framing = multipartBody(0, '-'.repeat(70)).body.byteLength + 4096
        expect(framing).toBeLessThan(MULTIPART_OVERHEAD_BYTES)
    })
})
