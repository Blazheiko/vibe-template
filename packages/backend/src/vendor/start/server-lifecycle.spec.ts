import { connect, createServer } from 'node:net'

import { afterAll, describe, expect, it, vi } from 'vitest'

// feat-112 (R08) on a real uWebSockets.js server:
// - a failed listen rejects initServer with the reason (it used to log success or nothing);
// - a throw in the static cache handler answers 500 and the server keeps serving;
// - stopServer closes the listen socket before it closes the WebSockets.

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
const app = vi.hoisted(() => ({ unixPath: undefined as string | undefined }))

vi.hoisted(() => {
    process.env['APP_KEY'] ??= 'k'.repeat(16) + '3f9a1c7e5b2d4f60'
})
const silent = vi.hoisted(() => {
    const logger = {
        error: vi.fn(),
        warn: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
        fatal: vi.fn(),
        child: (): unknown => logger,
    }
    return logger
})
vi.mock('#logger', () => ({ default: silent }))
vi.mock('#vendor/utils/logger.js', () => ({ default: silent }))
vi.mock('#config/app.js', async (importOriginal) => {
    const actual = await importOriginal<{ default: Record<string, unknown> }>()
    return {
        default: new Proxy(
            {
                ...actual.default,
                host: '127.0.0.1',
                port: PORT,
                serveStatic: true,
                pathPrefix: 'api',
            },
            {
                get: (target, key) =>
                    key === 'unixPath'
                        ? app.unixPath
                        : (target as Record<string | symbol, unknown>)[key],
            },
        ),
    }
})
const staticCacheHandler = vi.hoisted(() => vi.fn())
vi.mock('#vendor/start/static-server.js', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>()
    return {
        ...actual,
        cacheStaticSource: () =>
            Promise.resolve(new Map([['/broken.js', { kind: 'memory', etag: '"x"' }]])),
        staticCacheHandler,
    }
})

// feat-126: closeAllWs held open, so the test sees what is true WHILE the sockets close.
const wsClose = vi.hoisted(() => ({ release: (): void => undefined, started: false }))
vi.mock('#vendor/utils/network/ws-handlers.js', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>()
    return {
        ...actual,
        closeAllWs: () =>
            new Promise<void>((resolve) => {
                wsClose.started = true
                wsClose.release = resolve
            }),
    }
})

const server = await import('./server.js')
const ROUTES = {
    httpRoutes: [],
    wsRoutesByUrl: new Map(),
    sourceHttpRoutes: [],
    sourceWsRoutes: [],
} as never

afterAll(async () => {
    const stopping = server.stopServer('test')
    wsClose.release()
    await stopping
})

describe('server lifecycle (feat-112)', () => {
    it('rejects with the reason when the unix socket cannot be listened on', async () => {
        // A directory that does not exist: listen_unix gives false. (A path over the OS length
        // limit crashes uWS natively instead; validateRuntimeConfig refuses it before this.)
        app.unixPath = '/nonexistent-feat-112/app.sock'
        try {
            await expect(server.initServer(ROUTES)).rejects.toThrow(
                'Failed to listen on unix socket /nonexistent-feat-112/app.sock',
            )
        } finally {
            app.unixPath = undefined
        }
    })

    it('answers 500 when the static cache handler throws, and keeps serving', async () => {
        staticCacheHandler.mockRejectedValue(new Error('boom'))
        await server.initServer(ROUTES)

        const first = await fetch(`http://127.0.0.1:${String(PORT)}/broken.js`)
        const second = await fetch(`http://127.0.0.1:${String(PORT)}/broken.js`)

        expect(first.status).toBe(500)
        expect(second.status).toBe(500)
        expect(silent.error).toHaveBeenCalledWith(
            expect.objectContaining({ url: '/broken.js' }),
            'Unhandled static cache handler error',
        )
    })

    // feat-126: before, this case passed whatever the order (both steps had run by the check).
    // Now the check runs while the WebSockets are still closing.
    it('stops accepting connections before it closes the WebSockets', async () => {
        const stopping = server.stopServer('test')
        await vi.waitFor(() => {
            expect(wsClose.started).toBe(true)
        })

        // A new TCP connection, not fetch: its keep-alive pool would reuse an open one.
        const refused = await new Promise<string>((resolve) => {
            const socket = connect(PORT, '127.0.0.1')
            socket.once('connect', () => {
                socket.destroy()
                resolve('connected')
            })
            socket.once('error', (err: NodeJS.ErrnoException) => {
                resolve(err.code ?? 'error')
            })
        })
        expect(refused).toBe('ECONNREFUSED')
        wsClose.release()
        await stopping
    })
})
