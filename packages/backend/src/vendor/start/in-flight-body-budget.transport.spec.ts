import { connect, createServer, type Socket } from 'node:net'

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * feat-201 (security review 2026-11-12, M-3) on a real uWebSockets.js server: a client that
 * sends most of a body and stops holds its bytes; the next body of the same address over the
 * in-flight budget is answered 429 and its connection is closed; the bytes come back when the
 * stalled client goes away. Raw sockets, so the test decides which bytes go out and when.
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
const PER_IP = 300
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
            maxJsonBodySize: 10_000,
            maxInFlightBodyBytes: 100_000,
            maxInFlightBodyBytesPerIp: PER_IP,
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
        url: 'api/budget/json',
        middlewares: [],
        validator: { validate: (input: unknown) => ({ ok: true, value: input }) },
        // No runtime check of the answer: the handler's payload goes out as it is.
        responseCheck: null,
        handler,
    },
]

interface RawResponse {
    statusLine: string
    headers: Map<string, string>
    body: string
}

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

const head = (contentLength: number): string =>
    'POST /api/budget/json HTTP/1.1\r\n' +
    'Host: 127.0.0.1\r\n' +
    'Content-Type: application/json\r\n' +
    `Content-Length: ${String(contentLength)}\r\n\r\n`

/** A JSON object of exactly `bytes` bytes. */
const jsonOf = (bytes: number): string => `{"s":"${'a'.repeat(bytes - 8)}"}`

const open: Socket[] = []

/** Sends the headers and only the first `sent` bytes of a body of `declared` bytes, then stops. */
const stall = (declared: number, sent: number): Promise<Socket> =>
    new Promise((resolve, reject) => {
        const socket = connect(PORT, '127.0.0.1', () => {
            socket.write(head(declared) + jsonOf(declared).slice(0, sent), () => {
                resolve(socket)
            })
        })
        socket.on('error', reject)
        open.push(socket)
    })

/** One whole request; resolves with the answer and whether the server closed the connection. */
const request = (bytes: number): Promise<RawResponse & { closedByServer: boolean }> =>
    new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(`no full response within ${String(RESPONSE_TIMEOUT_MS)} ms`))
        }, RESPONSE_TIMEOUT_MS)
        let data = Buffer.alloc(0)
        let parsed: RawResponse | null = null
        const socket = connect(PORT, '127.0.0.1', () => {
            socket.write(head(bytes) + jsonOf(bytes))
        })
        open.push(socket)
        const finish = (closedByServer: boolean): void => {
            if (parsed === null) return
            clearTimeout(timer)
            socket.destroy()
            resolve({ ...parsed, closedByServer })
        }
        socket.on('data', (chunk: Buffer) => {
            data = Buffer.concat([data, chunk])
            parsed ??= tryParse(data)
            // A kept-alive connection stays open: give the server a moment to close it.
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

let stopServer: (type?: string) => Promise<void>
let bodyBytesInFlight: (ipKey?: string) => number

const waitUntilFree = async (): Promise<void> => {
    const deadline = Date.now() + RESPONSE_TIMEOUT_MS
    while (bodyBytesInFlight() !== 0) {
        if (Date.now() > deadline) throw new Error('the in-flight budget did not come back')
        await new Promise((resolve) => setTimeout(resolve, 10))
    }
}

beforeAll(async () => {
    const wsHandlers = await import('#vendor/utils/network/ws-handlers.js')
    wsHandlers.registerWsAppHooks({
        onUpgrade: () => Promise.resolve({ kind: 'missing' as const }),
        onConnected: () => Promise.resolve(),
        onDisconnected: () => Promise.resolve(),
    })
    ;({ bodyBytesInFlight } = await import('#vendor/utils/network/body-budget.js'))

    const server = await import('./server.js')
    stopServer = server.stopServer
    await server.initServer({
        httpRoutes: routes,
        wsRoutesByUrl: new Map(),
        sourceHttpRoutes: [],
        sourceWsRoutes: [],
    } as never)
})

beforeEach(async () => {
    for (const socket of open.splice(0)) socket.destroy()
    await waitUntilFree()
    handler.mockClear()
})

afterAll(async () => {
    for (const socket of open.splice(0)) socket.destroy()
    await stopServer('test')
})

describe('in-flight body budget on a real uWS server', () => {
    it('a body within the budget is handled as before', async () => {
        const response = await request(200)

        expect(response.statusLine).toBe('HTTP/1.1 200 OK')
        expect(handler).toHaveBeenCalledTimes(1)
        expect(bodyBytesInFlight()).toBe(0)
    })

    it('a stalled upload holds its bytes: the next body over the budget gets 429 and a closed connection', async () => {
        // 250 of 280 bytes sent, then nothing: the request never completes.
        await stall(280, 250)
        await vi.waitFor(() => {
            expect(bodyBytesInFlight()).toBe(250)
        })

        const refused = await request(100)

        expect(refused.statusLine).toBe('HTTP/1.1 429 Too Many Requests')
        expect(refused.headers.get('retry-after')).toBe('1')
        expect(refused.headers.get('connection')).toBe('close')
        expect(JSON.parse(refused.body)).toMatchObject({ status: 'error', code: 'rate_limited' })
        expect(refused.closedByServer).toBe(true)
        expect(handler).not.toHaveBeenCalled()
        // The refused request gave back what it had charged; the stalled one still holds its own.
        expect(bodyBytesInFlight()).toBe(250)
    })

    it('a body that still fits next to the stalled one is handled', async () => {
        await stall(280, 250)
        await vi.waitFor(() => {
            expect(bodyBytesInFlight()).toBe(250)
        })

        const response = await request(40)

        expect(response.statusLine).toBe('HTTP/1.1 200 OK')
        expect(handler).toHaveBeenCalledTimes(1)
    })

    it('the bytes come back when the stalled client goes away', async () => {
        const stalled = await stall(280, 250)
        await vi.waitFor(() => {
            expect(bodyBytesInFlight()).toBe(250)
        })
        expect((await request(100)).statusLine).toBe('HTTP/1.1 429 Too Many Requests')

        stalled.destroy()
        await waitUntilFree()

        const response = await request(100)
        expect(response.statusLine).toBe('HTTP/1.1 200 OK')
    })

    it('many stalled uploads of one address never hold more than its budget', async () => {
        // Each tries to park 200 bytes; the address may hold 300.
        for (let n = 0; n < 6; n += 1) await stall(250, 200)
        await new Promise((resolve) => setTimeout(resolve, 150))

        expect(bodyBytesInFlight()).toBeLessThanOrEqual(PER_IP)
        expect(bodyBytesInFlight()).toBe(200)
    })
})
