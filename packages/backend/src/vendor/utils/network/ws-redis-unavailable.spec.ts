import { beforeEach, describe, expect, it, vi } from 'vitest'

import appConfig from '#config/app.js'
import { RedisUnavailableError } from './errors/redis-unavailable-error.js'

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
const onRefreshToken = vi.fn()

const handlers = await import('./ws-handlers.js')
handlers.registerWsAppHooks({
    onUpgrade,
    onConnected: vi.fn(),
    onDisconnected: vi.fn(),
    onRefreshToken,
    onRevokeToken: vi.fn(),
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
            token: 'wstoken',
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
    onRefreshToken.mockResolvedValue(undefined)
})

describe('onMessage heartbeat', () => {
    it('answers pong before any Redis command and does not wait for refresh', async () => {
        const ws = createWs()
        onRefreshToken.mockImplementation(() => {
            ws.order.push('refresh')
            return new Promise(() => {}) // hangs
        })

        await handlers.onMessage(ws as never, message('ping'), false, {})

        expect(ws.order).toEqual(['send:pong', 'refresh'])
        expect(ws.end).not.toHaveBeenCalled()
        expect(wsSessionHandler).not.toHaveBeenCalled()
    })

    it('does not log when the refresh for ping finds Redis unavailable', async () => {
        const ws = createWs()
        onRefreshToken.mockRejectedValue(new RedisUnavailableError())

        await handlers.onMessage(ws as never, message('ping'), false, {})
        await new Promise((resolve) => setImmediate(resolve))

        expect(ws.sent).toEqual(['pong'])
        expect(logger.error).not.toHaveBeenCalled()
        expect(logger.warn).not.toHaveBeenCalled()
    })

    it('still logs other refresh errors', async () => {
        const ws = createWs()
        onRefreshToken.mockRejectedValue(new Error('boom'))

        await handlers.onMessage(ws as never, message('ping'), false, {})
        await new Promise((resolve) => setImmediate(resolve))

        expect(logger.error).toHaveBeenCalledWith(
            expect.objectContaining({ err: expect.any(Error) }),
            'Error refresh token',
        )
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

    it('refresh unavailable → service_unavailable with the event, session not read', async () => {
        const ws = createWs()
        onRefreshToken.mockRejectedValue(new RedisUnavailableError())

        await handlers.onMessage(ws as never, message(APP_MESSAGE), false, {})

        expectServiceUnavailable(ws)
        expect(wsSessionHandler).not.toHaveBeenCalled()
        expect(wsApiHandler).not.toHaveBeenCalled()
    })

    it('session unavailable → service_unavailable, connection kept', async () => {
        const ws = createWs()
        wsSessionHandler.mockResolvedValue({ kind: 'unavailable' })

        await handlers.onMessage(ws as never, message(APP_MESSAGE), false, {})

        expectServiceUnavailable(ws)
        expect(wsApiHandler).not.toHaveBeenCalled()
    })

    it('session missing → closed as expired (4001), as before', async () => {
        const ws = createWs()
        wsSessionHandler.mockResolvedValue({ kind: 'missing' })

        await handlers.onMessage(ws as never, message(APP_MESSAGE), false, {})

        expect(ws.end).toHaveBeenCalledWith(4001)
    })

    it('session ok → dispatched', async () => {
        const ws = createWs()
        const session = { sessionInfo: { id: 's1' } }
        wsSessionHandler.mockResolvedValue({ kind: 'ok', session })
        wsApiHandler.mockResolvedValue({ status: 'success', event: 'api/user/me' })

        await handlers.onMessage(ws as never, message(APP_MESSAGE), false, {})

        expect(wsApiHandler).toHaveBeenCalledWith(
            expect.anything(),
            ws,
            expect.anything(),
            session,
            {},
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
})
