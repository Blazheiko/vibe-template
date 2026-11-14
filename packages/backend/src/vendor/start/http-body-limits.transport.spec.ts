import { connect, createServer, type Socket } from 'node:net'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * Body limits on a real uWebSockets.js server (no fake App): what a client that
 * is still sending (or never sends) the body actually receives. The client is a
 * raw socket so the test controls exactly which bytes go out and when.
 */

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
const JSON_LIMIT = 64
const RESPONSE_TIMEOUT_MS = 2_000

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
            maxJsonBodySize: JSON_LIMIT,
        },
    }
})
vi.mock('#vendor/utils/middlewares/core/execute-httpMiddlewares.js', () => ({
    default: vi.fn().mockResolvedValue(true),
}))
vi.mock('#vendor/utils/session/session-handler.js', () => ({
    wsSessionHandler: vi.fn(),
}))

const handler = vi.fn(() => ({ ok: true }))

const routes = [
    {
        method: 'post',
        url: 'api/limits/json',
        middlewares: [],
        validator: { validate: (input: unknown) => ({ ok: true, value: input }) },
        handler,
    },
]

interface RawResponse {
    statusLine: string
    headers: Map<string, string>
    body: string
}

// Parses one full HTTP/1.1 response framed by Content-Length.
const tryParse = (data: Buffer): RawResponse | null => {
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

/**
 * Opens a socket, lets `write` send bytes, and resolves with the first full
 * response. A timer rejects the wait, so a hung server fails the test instead
 * of blocking the run; `finally` always clears the timer and destroys the socket.
 */
const exchange = async (write: (socket: Socket) => void): Promise<RawResponse> => {
    let socket: Socket | undefined
    let timer: NodeJS.Timeout | undefined
    try {
        return await new Promise<RawResponse>((resolve, reject) => {
            timer = setTimeout(() => {
                reject(new Error(`no full response within ${String(RESPONSE_TIMEOUT_MS)} ms`))
            }, RESPONSE_TIMEOUT_MS)
            let data = Buffer.alloc(0)
            socket = connect(PORT, '127.0.0.1', () => {
                if (socket !== undefined) write(socket)
            })
            socket.on('data', (chunk: Buffer) => {
                data = Buffer.concat([data, chunk])
                const parsed = tryParse(data)
                if (parsed !== null) resolve(parsed)
            })
            socket.on('error', reject)
            socket.on('close', () => {
                reject(new Error('connection closed before a full response'))
            })
        })
    } finally {
        clearTimeout(timer)
        socket?.destroy()
    }
}

const expectFull413 = (response: RawResponse): void => {
    expect(response.statusLine).toBe('HTTP/1.1 413 Payload Too Large')
    expect(JSON.parse(response.body)).toMatchObject({
        code: 'payload_too_large',
        details: { limit: JSON_LIMIT, contentType: 'application/json' },
    })
    expect(handler).not.toHaveBeenCalled()
}

let stopServer: (type?: string) => Promise<void>

beforeAll(async () => {
    // stopServer closes WebSockets through the app hooks, so they must exist.
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

describe('HTTP body limits on a real uWS server', () => {
    it('answers 413 to an oversized Content-Length when only headers were sent', async () => {
        const response = await exchange((socket) => {
            socket.write(
                'POST /api/limits/json HTTP/1.1\r\n' +
                    'Host: 127.0.0.1\r\n' +
                    'Content-Type: application/json\r\n' +
                    `Content-Length: ${String(JSON_LIMIT * 100)}\r\n\r\n`,
            )
        })

        expectFull413(response)
    })

    it('answers 413 when a non-final chunk exceeds the limit, without the terminating chunk', async () => {
        const response = await exchange((socket) => {
            const chunk = `{"s":"${'a'.repeat(JSON_LIMIT)}`
            socket.write(
                'POST /api/limits/json HTTP/1.1\r\n' +
                    'Host: 127.0.0.1\r\n' +
                    'Content-Type: application/json\r\n' +
                    'Transfer-Encoding: chunked\r\n\r\n' +
                    `${Buffer.byteLength(chunk).toString(16)}\r\n${chunk}\r\n`,
            )
            // No "0\r\n\r\n": the body is never finished.
        })

        expectFull413(response)
    })
})
