import { beforeEach, describe, expect, it, vi } from 'vitest'

import appConfig from '#config/app.js'

const logger = vi.hoisted(() => ({
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
}))
vi.mock('#vendor/utils/logger.js', () => ({ default: logger }))
vi.mock('#database/redis-rate-limit.js', () => ({
    default: { eval: vi.fn().mockResolvedValue([1, 1, 0]) },
}))
const wsApiHandler = vi.hoisted(() => vi.fn())
vi.mock('../routing/ws-api-dispatcher.js', () => ({ default: wsApiHandler }))
const wsSessionHandler = vi.hoisted(() => vi.fn())
vi.mock('../session/session-handler.js', () => ({ wsSessionHandler }))
vi.mock('./get-ip.js', () => ({ default: () => '10.9.0.1' }))

const onUpgrade = vi.fn()

const handlers = await import('./ws-handlers.js')

// feat-197: an event no route answers is refused before the session is read, so the events of
// these tests need a route. The dispatcher is mocked: only the names matter.
const ROUTES = {
    main: {},
    support: {},
    user: {},
    'api/user/me': {},
    'some/route': {},
} as never
handlers.registerWsAppHooks({
    onUpgrade,
    onConnected: vi.fn(),
    onDisconnected: vi.fn(),
})
handlers.registerWsMessageValidator({
    validate: (value: unknown) => ({ ok: true, value }) as never,
})

const createWs = () => {
    const sent: string[] = []
    const order: string[] = []
    const ws = {
        sent,
        order,
        getUserData: () => ({
            sessionId: 's1',
            userToken: 'u1',
            userId: '1',
        }),
        cork: (cb: () => void) => {
            cb()
        },
        send: vi.fn((data: string) => {
            order.push(`send:${data === 'pong' ? 'pong' : 'json'}`)
            sent.push(data)
        }),
        end: vi.fn(),
        close: vi.fn(),
    }
    return ws
}

const message = (text: string): ArrayBuffer => {
    const bytes = new TextEncoder().encode(text)
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
}
const APP_MESSAGE = JSON.stringify({ event: 'api/user/me', timestamp: 123, payload: {} })

beforeEach(() => {
    vi.clearAllMocks()
})

describe('onMessage heartbeat', () => {
    // feat-196: the WS token is consumed by the upgrade, so a heartbeat has nothing to refresh
    // and costs no Redis command at all.
    it('answers pong without reading the session or touching Redis', async () => {
        const ws = createWs()

        await handlers.onMessage(ws as never, message('ping'), false, ROUTES)

        expect(ws.order).toEqual(['send:pong'])
        expect(ws.end).not.toHaveBeenCalled()
        expect(wsSessionHandler).not.toHaveBeenCalled()
        expect(logger.error).not.toHaveBeenCalled()
        expect(logger.warn).not.toHaveBeenCalled()
    })
})

describe('onMessage application requests', () => {
    const expectServiceUnavailable = (ws: ReturnType<typeof createWs>): void => {
        expect(ws.sent).toHaveLength(1)
        expect(JSON.parse(ws.sent[0] ?? '')).toMatchObject({
            status: 'error',
            event: 'api/user/me',
            data: null,
            error: { code: 'service_unavailable' },
        })
        expect(ws.end).not.toHaveBeenCalled()
        expect(ws.close).not.toHaveBeenCalled()
        expect(logger.error).not.toHaveBeenCalled()
    }

    it('session unavailable → service_unavailable, connection kept', async () => {
        const ws = createWs()
        wsSessionHandler.mockResolvedValue({ kind: 'unavailable' })

        await handlers.onMessage(ws as never, message(APP_MESSAGE), false, ROUTES)

        expectServiceUnavailable(ws)
        expect(wsApiHandler).not.toHaveBeenCalled()
    })

    it('session missing → closed as expired (4001), as before', async () => {
        const ws = createWs()
        wsSessionHandler.mockResolvedValue({ kind: 'missing' })

        await handlers.onMessage(ws as never, message(APP_MESSAGE), false, ROUTES)

        expect(ws.end).toHaveBeenCalledWith(4001)
    })

    it('session ok → dispatched', async () => {
        const ws = createWs()
        const session = { sessionInfo: { id: 's1' } }
        wsSessionHandler.mockResolvedValue({ kind: 'ok', session })
        wsApiHandler.mockResolvedValue({ status: 'success', event: 'api/user/me' })

        await handlers.onMessage(ws as never, message(APP_MESSAGE), false, ROUTES)

        expect(wsApiHandler).toHaveBeenCalledWith(
            expect.anything(),
            ws,
            expect.anything(),
            session,
            ROUTES,
        )
    })
})

describe('handleUpgrade while Redis is unavailable', () => {
    const VALID_TOKEN = 'a'.repeat(appConfig.accessTokenLength)

    const createRes = () => {
        const calls: string[] = []
        let onAbort: () => void = () => {}
        const res = {
            calls,
            abort: () => {
                onAbort()
            },
            onAborted: (cb: () => void) => {
                onAbort = cb
                return res
            },
            cork: (cb: () => void) => {
                calls.push('cork')
                cb()
                return res
            },
            writeStatus: (status: string) => {
                calls.push(status)
                return res
            },
            writeHeader: (name: string, value: string) => {
                calls.push(`${name}: ${value}`)
                return res
            },
            end: () => {
                calls.push('end')
                return res
            },
            upgrade: () => {
                calls.push('upgrade')
            },
            getProxiedRemoteAddressAsText: () => new ArrayBuffer(0),
        }
        return res
    }
    const req = {
        getHeader: (name: string) =>
            name === 'sec-websocket-protocol' ? `${VALID_TOKEN}, app-web` : '',
    }

    it('answers 503 with Retry-After before res.upgrade', async () => {
        onUpgrade.mockResolvedValue({ kind: 'unavailable' })
        const res = createRes()

        await handlers.handleUpgrade(res as never, req as never, {})

        expect(res.calls).toEqual(['cork', '503 Service Unavailable', 'Retry-After: 1', 'end'])
        expect(onUpgrade).toHaveBeenCalledTimes(1)
    })

    it('writes nothing when the client aborts during the token check', async () => {
        const res = createRes()
        onUpgrade.mockImplementation(() => {
            res.abort()
            return Promise.resolve({ kind: 'unavailable' })
        })

        await handlers.handleUpgrade(res as never, req as never, {})

        expect(res.calls).toEqual([])
    })

    it('missing session answers 401 before res.upgrade (code-issues item 18)', async () => {
        onUpgrade.mockResolvedValue({ kind: 'missing' })
        const res = createRes()

        await handlers.handleUpgrade(res as never, req as never, {})

        expect(res.calls).toEqual(['cork', '401 Unauthorized', 'end'])
        expect(res.calls).not.toContain('upgrade')
    })

    // An unexpected throw in the upgrade (a bug, a hook that throws) used to reject the promise
    // uWS does not await: with no unhandledRejection listener (index.ts) that stops the process.
    it('an unexpected error answers 500 and resolves instead of rejecting', async () => {
        onUpgrade.mockRejectedValue(new TypeError('boom'))
        const res = createRes()

        await expect(
            handlers.handleUpgrade(res as never, req as never, {}),
        ).resolves.toBeUndefined()

        expect(res.calls).toEqual(['cork', '500 Internal Server Error', 'end'])
        expect(logger.error).toHaveBeenCalledWith(
            expect.objectContaining({ err: expect.any(TypeError) }),
            'WebSocket upgrade failed',
        )
    })

    it('an unexpected error after the client aborted writes nothing', async () => {
        const res = createRes()
        onUpgrade.mockImplementation(() => {
            res.abort()
            return Promise.reject(new TypeError('boom'))
        })

        await expect(
            handlers.handleUpgrade(res as never, req as never, {}),
        ).resolves.toBeUndefined()

        expect(res.calls).toEqual([])
    })

    it('a live session upgrades', async () => {
        onUpgrade.mockResolvedValue({ kind: 'ok', sessionId: 's1', userId: '1', userToken: 'u1' })
        const res = createRes()

        await handlers.handleUpgrade(res as never, req as never, {})

        expect(res.calls).toEqual(['cork', 'upgrade'])
    })

    // feat-138 (sixth review L12): an upgrade still waiting on its token check when the server
    // began shutting down upgraded after closeAllWs, opening a socket nobody closes or revokes.
    it('an upgrade that finishes after shutdown began answers 503 instead of upgrading', async () => {
        const res = createRes()
        let finishCheck: (value: unknown) => void = () => undefined
        onUpgrade.mockImplementation(
            () =>
                new Promise((resolve) => {
                    finishCheck = resolve
                }),
        )

        const upgrading = handlers.handleUpgrade(res as never, req as never, {})
        await new Promise((resolve) => setTimeout(resolve, 0))
        await handlers.closeAllWs()
        finishCheck({ kind: 'ok', sessionId: 's1', userId: '1', userToken: 'u1' })
        await upgrading

        expect(res.calls).not.toContain('upgrade')
        expect(res.calls).toContain('503 Service Unavailable')
        handlers.__acceptUpgradesForTests()
    })
})
