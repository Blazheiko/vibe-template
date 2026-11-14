import { randomBytes } from 'node:crypto'
import { request, type IncomingHttpHeaders } from 'node:http'
import { createServer } from 'node:net'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * Smoke test on a real uWebSockets.js server (no fake App): the synchronous rate-limit
 * check must not lose the body of small POSTs, and the upgrade limiter must answer a
 * real handshake. Handshakes go through node:http, not WebSocket: the WebSocket API
 * hides the status and headers of a refused handshake.
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
const UPGRADE_WINDOW_MS = 1_000

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
vi.mock('#config/rate-limit.js', () => ({
    default: {
        httpGlobal: { windowMs: 60_000, max: 100 },
        wsUpgrade: { windowMs: UPGRADE_WINDOW_MS, max: 2 },
        configError: null,
    },
}))
vi.mock('#vendor/utils/middlewares/core/execute-httpMiddlewares.js', () => ({
    default: vi.fn().mockResolvedValue(true),
}))
vi.mock('#vendor/utils/session/session-handler.js', () => ({
    wsSessionHandler: vi.fn(),
}))

const received: unknown[] = []
const blockedHandler = vi.fn(() => ({ ok: true }))

const routes = [
    {
        method: 'post',
        url: 'api/rl-smoke/echo',
        middlewares: [],
        // Without a validator the pipeline hands the handler `null` instead of the body.
        validator: { validate: (input: unknown) => ({ ok: true, value: input }) },
        handler: (context: { httpData: { payload: unknown } }) => {
            received.push(context.httpData.payload)
            return { echo: context.httpData.payload }
        },
    },
    {
        method: 'post',
        url: 'api/rl-smoke/limited',
        middlewares: [],
        rateLimit: { windowMs: 60_000, maxRequests: 1 },
        handler: blockedHandler,
    },
]

interface HttpResult {
    status: number
    headers: IncomingHttpHeaders
    body: string
}

const post = (path: string, body: string) =>
    new Promise<HttpResult>((resolve, reject) => {
        const req = request(
            {
                host: '127.0.0.1',
                port: PORT,
                path,
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(body),
                },
            },
            (res) => {
                let data = ''
                res.on('data', (chunk: Buffer) => (data += chunk.toString()))
                res.on('end', () => {
                    resolve({
                        status: res.statusCode ?? 0,
                        headers: res.headers,
                        body: data,
                    })
                })
            },
        )
        req.on('error', reject)
        req.end(body)
    })

type Handshake =
    | { kind: 'upgrade'; status: number }
    | { kind: 'response'; status: number; headers: IncomingHttpHeaders }

let token = ''

const handshake = () =>
    new Promise<Handshake>((resolve, reject) => {
        const req = request({
            host: '127.0.0.1',
            port: PORT,
            path: '/api/websocket',
            headers: {
                Connection: 'Upgrade',
                Upgrade: 'websocket',
                'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
                'Sec-WebSocket-Version': '13',
                'Sec-WebSocket-Protocol': `${token}, web`,
            },
        })
        req.on('upgrade', (res, socket) => {
            socket.destroy()
            resolve({ kind: 'upgrade', status: res.statusCode ?? 0 })
        })
        req.on('response', (res) => {
            res.resume()
            resolve({
                kind: 'response',
                status: res.statusCode ?? 0,
                headers: res.headers,
            })
        })
        req.on('error', reject)
        req.end()
    })

let stopServer: (type?: string) => Promise<void>

beforeAll(async () => {
    const appConfig = (await import('#config/app.js')).default
    token = 'a'.repeat(appConfig.accessTokenLength)

    const wsHandlers = await import('#vendor/utils/network/ws-handlers.js')
    wsHandlers.registerWsAppHooks({
        onUpgrade: () =>
            Promise.resolve({
                kind: 'ok' as const,
                sessionId: 's',
                userId: '1',
                userToken: 'u',
            }),
        onConnected: () => Promise.resolve(),
        onDisconnected: () => Promise.resolve(),
    })

    const server = await import('./server.js')
    stopServer = server.stopServer
    await server.initServer({
        httpRoutes: routes.map((route) => ({ ...route, responseCheck: null })),
        wsRoutesByUrl: new Map(),
        sourceHttpRoutes: [],
        sourceWsRoutes: [],
    } as never)
})

afterAll(async () => {
    await stopServer('test')
})

describe('HTTP rate limit on a real uWS server', () => {
    it('an allowed small POST reaches the handler with its body', async () => {
        const response = await post('/api/rl-smoke/echo', '{"n":1}')
        expect(response.status).toBe(200)
        expect(received).toEqual([{ n: 1 }])
    })

    it('a blocked POST gets 429 and never reaches the handler', async () => {
        expect((await post('/api/rl-smoke/limited', '{"n":1}')).status).toBe(200)
        const blocked = await post('/api/rl-smoke/limited', '{"n":2}')
        expect(blocked.status).toBe(429)
        expect(blocked.headers['retry-after']).toBe('60')
        expect(blockedHandler).toHaveBeenCalledTimes(1)
    })
})

describe('WebSocket upgrade rate limit on a real uWS server', () => {
    it('upgrades, refuses over the limit with 429, recovers after the window', async () => {
        expect(await handshake()).toEqual({ kind: 'upgrade', status: 101 })
        expect(await handshake()).toEqual({ kind: 'upgrade', status: 101 })

        const refused = await handshake()
        expect(refused).toMatchObject({ kind: 'response', status: 429 })
        if (refused.kind === 'response') {
            expect(refused.headers['retry-after']).toBe('1')
        }

        await new Promise((resolve) => setTimeout(resolve, UPGRADE_WINDOW_MS + 50))
        expect(await handshake()).toEqual({ kind: 'upgrade', status: 101 })
    })
})
