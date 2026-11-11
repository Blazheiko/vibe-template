import { LoginInputSchema } from 'shared/schemas'
import { describe, expect, it, vi } from 'vitest'

import { defineRoute } from '#app/routing/define-route.js'

// An invalid login body is rejected by the route validator before the
// controller runs, so the login throttle (called from authService.login) is
// never consumed for it.

type Handler = (res: unknown, req: unknown) => unknown
const handlers = new Map<string, Handler>()
const fakeApp = {
    ws: vi.fn(),
    listen: vi.fn((_h: string, _p: number, cb: (token: unknown) => void) => {
        cb({})
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
vi.mock('#vendor/utils/network/get-ip.js', () => ({
    default: () => '127.0.0.1',
}))
vi.mock('#app/routes/http-routes.js', () => ({ default: [] }))
vi.mock('#app/routes/ws-routes.js', () => ({ default: [] }))
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
const consumeAuthThrottle = vi.fn()
vi.mock('#app/services/auth/auth-throttle-service.js', () => ({
    consumeAuthThrottle,
    resetAuthThrottle: vi.fn(),
}))

const controller = vi.fn(() => ({ status: 'success' }))

const send = async (body: string): Promise<string> => {
    let status = ''
    let done: () => void = () => {}
    const finished = new Promise<void>((resolve) => {
        done = resolve
    })
    const res = {
        cork: (cb: () => void) => {
            cb()
            return res
        },
        onAborted: () => res,
        onData: (cb: (chunk: ArrayBuffer, isLast: boolean) => void) => {
            const bytes = new TextEncoder().encode(body)
            cb(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), true)
            return res
        },
        writeStatus: (s: string) => {
            status = s
            return res
        },
        writeHeader: () => res,
        end: () => {
            done()
            return res
        },
        close: () => {
            done()
            return res
        },
    }
    const headers: Record<string, string> = {
        'content-type': 'application/json',
        'content-length': String(body.length),
    }
    const req = {
        getUrl: () => '/api/auth/login',
        getMethod: () => 'post',
        getQuery: () => '',
        getParameter: () => '',
        getHeader: (name: string) => headers[name] ?? '',
        forEach: (cb: (k: string, v: string) => void) => {
            Object.entries(headers).forEach(([k, v]) => {
                cb(k, v)
            })
        },
    }
    await handlers.get('post /api/auth/login')?.(res, req)
    await finished
    return status
}

describe('login body validation runs before the login throttle', () => {
    it('rejects an invalid body without calling the controller or the throttle', async () => {
        const { initServer } = await import('./server.js')
        await initServer({
            httpRoutes: [
                {
                    ...defineRoute({
                        url: '/auth/login',
                        method: 'post',
                        validator: LoginInputSchema,
                        handler: controller,
                    }),
                    url: 'api/auth/login',
                    middlewares: [],
                },
            ].map((route) => ({ ...route, responseCheck: null })),
            wsRoutesByUrl: new Map(),
            sourceHttpRoutes: [],
            sourceWsRoutes: [],
        } as never)

        const status = await send(JSON.stringify({ identifier: 'x' }))

        expect(status).toBe('422 Unprocessable Entity')
        expect(controller).not.toHaveBeenCalled()
        expect(consumeAuthThrottle).not.toHaveBeenCalled()
    })

    it('passes a valid body to the controller (harness sanity check)', async () => {
        const status = await send(
            JSON.stringify({
                identifier: 'user@example.com',
                password: 'secret123',
            }),
        )
        expect(status).toBe('200 OK')
        expect(controller).toHaveBeenCalledTimes(1)
    })
})
