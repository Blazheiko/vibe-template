import { beforeEach, describe, expect, it, vi } from 'vitest'

// feat-107 (R04): a uWS socket is dead once its close handler runs. onClose reads the socket
// and starts onDisconnected (which takes it out of the registry) before its first await, so
// nothing can find the socket while the Redis revoke is still running.
const logger = vi.hoisted(() => ({ debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() }))
vi.mock('#vendor/utils/logger.js', () => ({ default: logger }))
vi.mock('#database/redis-rate-limit.js', () => ({ default: { eval: vi.fn() } }))
const wsApiHandler = vi.hoisted(() => vi.fn())
vi.mock('../routing/ws-api-dispatcher.js', () => ({ default: wsApiHandler }))
const wsSessionHandler = vi.hoisted(() => vi.fn())
vi.mock('../session/session-handler.js', () => ({ wsSessionHandler }))

const order: string[] = []
let releaseRevoke: () => void = () => undefined
const hooks = {
    onUpgrade: vi.fn(),
    onConnected: vi.fn(),
    onDisconnected: vi.fn(() => {
        order.push('disconnected')
        return Promise.resolve()
    }),
    onRefreshToken: vi.fn().mockResolvedValue(undefined),
    onRevokeToken: vi.fn(
        () =>
            new Promise<void>((resolve) => {
                order.push('revoke started')
                releaseRevoke = () => {
                    order.push('revoke done')
                    resolve()
                }
            }),
    ),
}

const handlers = await import('./ws-handlers.js')
handlers.registerWsAppHooks(hooks)
handlers.registerWsMessageValidator({
    validate: (value: unknown) => ({ ok: true, value }) as never,
})

// A uWS socket that, like the real one, throws on any access once its close handler returned.
const createWs = (sendResult = 1) => {
    let dead = false
    const userData: Record<string, unknown> = {
        token: 'wstoken',
        sessionId: 's1',
        userToken: 'u1',
        userId: '1',
        uuid: 'c1',
    }
    const guard = <T>(value: T): T => {
        if (dead) throw new Error('Invalid access of closed uWS.WebSocket/SSLWebSocket.')
        return value
    }
    return {
        userData,
        kill: () => {
            dead = true
        },
        getUserData: () => guard(userData),
        getBufferedAmount: () => guard(70_000),
        cork: (cb: () => void) => {
            guard(undefined)
            cb()
        },
        send: vi.fn(() => guard(sendResult)),
        end: vi.fn(),
        close: vi.fn(),
    }
}

const message = (text: string): ArrayBuffer => {
    const bytes = new TextEncoder().encode(text)
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
}

beforeEach(() => {
    vi.clearAllMocks()
    order.length = 0
    wsSessionHandler.mockResolvedValue({ kind: 'ok', session: {} })
})

describe('onClose (feat-107)', () => {
    it('marks the socket closed and disconnects it before awaiting the token revoke', async () => {
        const ws = createWs()

        const closing = handlers.onClose(ws as never, 1001, new ArrayBuffer(0))
        // uWS invalidates the socket as soon as the close handler returns.
        ws.kill()

        expect(ws.userData['closed']).toBe(true)
        expect(order).toEqual(['disconnected', 'revoke started'])
        expect(hooks.onDisconnected).toHaveBeenCalledWith(ws, ws.userData, 1001)

        releaseRevoke()
        await closing
        expect(order).toEqual(['disconnected', 'revoke started', 'revoke done'])
        expect(logger.error).not.toHaveBeenCalled()
    })

    it('still revokes the token when onDisconnected fails', async () => {
        hooks.onDisconnected.mockImplementationOnce(() =>
            Promise.reject(new Error('presence down')),
        )
        const ws = createWs()

        const closing = handlers.onClose(ws as never, 1000, new ArrayBuffer(0))
        ws.kill()
        releaseRevoke()
        await closing

        expect(hooks.onRevokeToken).toHaveBeenCalledWith('wstoken')
        expect(logger.error).toHaveBeenCalledWith(
            expect.objectContaining({ err: expect.any(Error) }),
            'Error in onDisconnected hook',
        )
    })
})

describe('sendJson backpressure (feat-107)', () => {
    it('logs and closes the socket when uWS drops a reply', async () => {
        wsApiHandler.mockResolvedValue({ event: 'main:ping', status: 'success', data: {} })
        const ws = createWs(2)

        await handlers.onMessage(
            ws as never,
            message(JSON.stringify({ event: 'main:ping', payload: {}, timestamp: Date.now() })),
            false,
            {},
        )

        expect(ws.send).toHaveBeenCalledTimes(1)
        expect(logger.warn).toHaveBeenCalledWith(
            expect.objectContaining({ bufferedAmount: 70_000 }),
            'WebSocket message dropped by backpressure, closing the connection',
        )
        expect(ws.end).toHaveBeenCalledWith(1013, 'Backpressure')
    })

    it('keeps the socket when the reply is only buffered (0) or sent (1)', async () => {
        wsApiHandler.mockResolvedValue({ event: 'main:ping', status: 'success', data: {} })
        for (const result of [0, 1]) {
            const ws = createWs(result)
            await handlers.onMessage(
                ws as never,
                message(JSON.stringify({ event: 'main:ping', payload: {}, timestamp: Date.now() })),
                false,
                {},
            )
            expect(ws.send).toHaveBeenCalledTimes(1)
            expect(ws.end).not.toHaveBeenCalled()
        }
    })
})

// feat-124: the client went away while the handler was working (an AI answer).
describe('a reply after the socket closed (feat-124)', () => {
    it('is not sent and logs no error', async () => {
        const ws = createWs()
        wsApiHandler.mockImplementation(() => {
            // The close handler runs while the handler awaits.
            void handlers.onClose(ws as never, 1001, new ArrayBuffer(0))
            ws.kill()
            releaseRevoke()
            return Promise.resolve({ event: 'main:ping', status: 'success', data: {} })
        })
        wsSessionHandler.mockResolvedValue({ kind: 'ok', session: {} })

        await handlers.onMessage(
            ws as never,
            message(JSON.stringify({ event: 'main:ping', payload: {}, timestamp: Date.now() })),
            false,
            {},
        )

        expect(ws.send).not.toHaveBeenCalled()
        expect(logger.error).not.toHaveBeenCalled()
    })
})
