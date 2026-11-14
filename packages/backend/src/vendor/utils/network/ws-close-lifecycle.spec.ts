import { beforeEach, describe, expect, it, vi } from 'vitest'

// feat-107 (R04): a uWS socket is dead once its close handler runs. onClose reads the socket
// and starts onDisconnected (which takes it out of the registry) before its first await, so
// nothing can find the socket while the rest of the close is still running. feat-196: there is
// no WS token left to revoke at close, the upgrade consumed it.
const logger = vi.hoisted(() => ({ debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() }))
vi.mock('#vendor/utils/logger.js', () => ({ default: logger }))
vi.mock('#database/redis-rate-limit.js', () => ({ default: { eval: vi.fn() } }))
const wsApiHandler = vi.hoisted(() => vi.fn())
vi.mock('../routing/ws-api-dispatcher.js', () => ({ default: wsApiHandler }))
const wsSessionHandler = vi.hoisted(() => vi.fn())
vi.mock('../session/session-handler.js', () => ({ wsSessionHandler }))

const order: string[] = []
let releaseDisconnect: () => void = () => undefined
const hooks = {
    onUpgrade: vi.fn(),
    onConnected: vi.fn(),
    onDisconnected: vi.fn(
        () =>
            new Promise<void>((resolve) => {
                order.push('disconnect started')
                releaseDisconnect = () => {
                    order.push('disconnect done')
                    resolve()
                }
            }),
    ),
}

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
handlers.registerWsAppHooks(hooks)
handlers.registerWsMessageValidator({
    validate: (value: unknown) => ({ ok: true, value }) as never,
})

// A uWS socket that, like the real one, throws on any access once its close handler returned.
const createWs = (sendResult = 1) => {
    let dead = false
    const userData: Record<string, unknown> = {
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
    it('marks the socket closed and disconnects it before its first await', async () => {
        const ws = createWs()

        const closing = handlers.onClose(ws as never, 1001, new ArrayBuffer(0))
        // uWS invalidates the socket as soon as the close handler returns.
        ws.kill()

        expect(ws.userData['closed']).toBe(true)
        expect(order).toEqual(['disconnect started'])
        expect(hooks.onDisconnected).toHaveBeenCalledWith(ws, ws.userData, 1001)

        releaseDisconnect()
        await closing
        expect(order).toEqual(['disconnect started', 'disconnect done'])
        expect(logger.error).not.toHaveBeenCalled()
    })

    it('logs a failing onDisconnected and still finishes the close', async () => {
        hooks.onDisconnected.mockImplementationOnce(() =>
            Promise.reject(new Error('presence down')),
        )
        const ws = createWs()

        const closing = handlers.onClose(ws as never, 1000, new ArrayBuffer(0))
        ws.kill()
        await expect(closing).resolves.toBeUndefined()

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
            ROUTES,
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
                ROUTES,
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
            releaseDisconnect()
            return Promise.resolve({ event: 'main:ping', status: 'success', data: {} })
        })
        wsSessionHandler.mockResolvedValue({ kind: 'ok', session: {} })

        await handlers.onMessage(
            ws as never,
            message(JSON.stringify({ event: 'main:ping', payload: {}, timestamp: Date.now() })),
            false,
            ROUTES,
        )

        expect(ws.send).not.toHaveBeenCalled()
        expect(logger.error).not.toHaveBeenCalled()
    })
})

// feat-128: the session lookup is awaited too; a session that vanished while the socket closed
// must not make the 4001 path touch the dead socket (an unknown error in the log).
describe('an expired session after the socket closed (feat-128)', () => {
    it('is not answered and logs no error', async () => {
        const ws = createWs()
        wsSessionHandler.mockImplementation(() => {
            void handlers.onClose(ws as never, 1001, new ArrayBuffer(0))
            ws.kill()
            releaseDisconnect()
            return Promise.resolve({ kind: 'missing' })
        })

        await handlers.onMessage(
            ws as never,
            message(JSON.stringify({ event: 'main:ping', payload: {}, timestamp: Date.now() })),
            false,
            ROUTES,
        )

        expect(ws.send).not.toHaveBeenCalled()
        expect(ws.end).not.toHaveBeenCalled()
        expect(logger.error).not.toHaveBeenCalled()
    })
})

// feat-133 (P3): onConnected failed (a database error reading the role) after the client got
// connection_established; the error was only logged, so the socket stayed open outside the
// registry: no broadcasts, pushes as if offline, and the client never reconnected.
describe('a failed onConnected hook (feat-133)', () => {
    it('closes the socket with 1011, so the client reconnects', async () => {
        const ws = createWs()
        hooks.onConnected.mockRejectedValueOnce(new Error('connection terminated'))

        handlers.onOpen(ws as never)
        await new Promise((resolve) => setTimeout(resolve, 0))

        expect(ws.end).toHaveBeenCalledWith(1011, 'Server error')
    })

    it('touches nothing when the socket closed while the hook ran', async () => {
        const ws = createWs()
        hooks.onConnected.mockImplementationOnce(() => {
            void handlers.onClose(ws as never, 1001, new ArrayBuffer(0))
            ws.kill()
            releaseDisconnect()
            return Promise.reject(new Error('connection terminated'))
        })

        handlers.onOpen(ws as never)
        await new Promise((resolve) => setTimeout(resolve, 0))

        expect(ws.end).not.toHaveBeenCalled()
        expect(logger.error).not.toHaveBeenCalledWith(
            expect.anything(),
            'Error closing a WebSocket after a failed onConnected',
        )
    })
})
