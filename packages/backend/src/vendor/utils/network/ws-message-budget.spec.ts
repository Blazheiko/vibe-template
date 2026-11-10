import { beforeEach, describe, expect, it, vi } from 'vitest'

// feat-149 (review 2026-11-10, M1): a connection has a budget of messages a minute, checked
// before anything that costs a Redis command or a PostgreSQL query. The counters below are the
// two costs: onRefreshToken is the Redis round trip of every message, wsSessionHandler reads the
// session from Redis and the session token from PostgreSQL.
const logger = vi.hoisted(() => ({ debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() }))
vi.mock('#vendor/utils/logger.js', () => ({ default: logger }))
vi.mock('#database/redis-rate-limit.js', () => ({ default: { eval: vi.fn() } }))
vi.mock('#config/websocket.js', () => ({
    default: { adminRecheckIntervalMs: 30_000, messagesPerMinute: 20, maxConcurrentHandlers: 3 },
}))
const wsApiHandler = vi.hoisted(() => vi.fn())
vi.mock('../routing/ws-api-dispatcher.js', () => ({ default: wsApiHandler }))
const wsSessionHandler = vi.hoisted(() => vi.fn())
vi.mock('../session/session-handler.js', () => ({ wsSessionHandler }))

const onRefreshToken = vi.fn()
const handlers = await import('./ws-handlers.js')
const { WS_PINGS_PER_MINUTE, WS_CLOSE_MESSAGE_FLOOD } =
    await import('../rate-limit/ws-message-budget.js')
handlers.registerWsAppHooks({
    onUpgrade: vi.fn(),
    onConnected: vi.fn(),
    onDisconnected: vi.fn(),
    onRefreshToken,
    onRevokeToken: vi.fn(),
})
handlers.registerWsMessageValidator({
    validate: (value: unknown) => ({ ok: true, value }) as never,
})

const BUDGET = 20
const MAX_CONCURRENT = 3

/** One connection: uWS hands out the same user data object for the life of the socket. */
const createConnection = () => {
    const sent: string[] = []
    const userData = { token: 'wstoken', sessionId: 's1', userToken: 'u1', userId: '1' }
    const ws = {
        sent,
        getUserData: () => userData,
        cork: (cb: () => void) => {
            cb()
        },
        // 1: sent (uWS answers 2 when the message was dropped by backpressure).
        send: vi.fn((data: string) => {
            sent.push(data)
            return 1
        }),
        end: vi.fn(),
        close: vi.fn(),
        getBufferedAmount: () => 0,
    }
    const send = (text: string): Promise<void> => {
        const bytes = new TextEncoder().encode(text)
        return handlers.onMessage(
            ws as never,
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
            false,
            {},
        )
    }
    const replies = (): Record<string, unknown>[] =>
        sent.filter((text) => text !== 'pong').map((text) => JSON.parse(text) as never)
    return { ws, send, replies }
}

const unknownEvent = (n: number): string =>
    JSON.stringify({ event: 'no/such/route', timestamp: n, payload: null })

beforeEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
    onRefreshToken.mockResolvedValue(undefined)
    wsSessionHandler.mockResolvedValue({ kind: 'ok', session: {} })
    wsApiHandler.mockImplementation((message: { event: string; timestamp: number }) =>
        Promise.resolve({
            status: 'error',
            data: null,
            event: message.event,
            timestamp: message.timestamp,
            error: { code: 'not_found', message: 'Not found' },
        }),
    )
})

describe('WS message budget of a connection', () => {
    it('checks the session for valid messages only until the budget is used up', async () => {
        const { send, replies } = createConnection()

        for (let n = 1; n <= BUDGET + 10; n += 1) await send(unknownEvent(n))

        expect(wsSessionHandler).toHaveBeenCalledTimes(BUDGET)
        expect(onRefreshToken).toHaveBeenCalledTimes(BUDGET)
        expect(replies().filter((reply) => reply['status'] === 'error')).toHaveLength(BUDGET + 10)
        expect(replies()[BUDGET]).toMatchObject({
            status: 'error',
            data: null,
            event: 'no/such/route',
            error: { code: 'rate_limited' },
        })
    })

    it('never checks the session for malformed JSON, and stops the Redis refresh at the budget', async () => {
        const { send, replies } = createConnection()

        for (let n = 1; n <= BUDGET + 10; n += 1) await send('{not json')

        expect(wsSessionHandler).not.toHaveBeenCalled()
        expect(onRefreshToken).toHaveBeenCalledTimes(BUDGET)
        expect(replies()[BUDGET]).toMatchObject({
            status: 'error',
            event: '',
            error: { code: 'rate_limited' },
        })
    })

    it('never checks the session for ping, always answers pong, and stops the Redis refresh at the ping budget', async () => {
        const { ws, send } = createConnection()

        for (let n = 1; n <= WS_PINGS_PER_MINUTE + 10; n += 1) await send('ping')

        expect(wsSessionHandler).not.toHaveBeenCalled()
        expect(ws.sent.filter((text) => text === 'pong')).toHaveLength(WS_PINGS_PER_MINUTE + 10)
        expect(onRefreshToken).toHaveBeenCalledTimes(WS_PINGS_PER_MINUTE)
    })

    it('keeps the ping budget apart: a used-up message budget does not stop the heartbeat refresh', async () => {
        const { send } = createConnection()
        for (let n = 1; n <= BUDGET + 1; n += 1) await send(unknownEvent(n))
        onRefreshToken.mockClear()

        await send('ping')

        expect(onRefreshToken).toHaveBeenCalledTimes(1)
    })

    it('starts a new budget in the next minute', async () => {
        vi.useFakeTimers({ now: 1_000_000 })
        const { send } = createConnection()
        for (let n = 1; n <= BUDGET + 1; n += 1) await send(unknownEvent(n))
        expect(wsSessionHandler).toHaveBeenCalledTimes(BUDGET)

        vi.setSystemTime(1_000_000 + 60_000)
        await send(unknownEvent(999))

        expect(wsSessionHandler).toHaveBeenCalledTimes(BUDGET + 1)
    })
})

describe('WS concurrent handlers of a connection', () => {
    it('refuses a message while the limit of handlers is running and takes one again when a handler ends', async () => {
        const { send, replies } = createConnection()
        const finish: (() => void)[] = []
        wsApiHandler.mockImplementation(
            (message: { event: string; timestamp: number }) =>
                new Promise((resolve) => {
                    finish.push(() => {
                        resolve({ status: 'ok', data: {}, event: message.event, error: null })
                    })
                }),
        )

        const running = Array.from({ length: MAX_CONCURRENT }, (_, n) => send(unknownEvent(n)))
        await vi.waitFor(() => {
            expect(finish).toHaveLength(MAX_CONCURRENT)
        })

        await send(unknownEvent(100))
        expect(wsSessionHandler).toHaveBeenCalledTimes(MAX_CONCURRENT)
        expect(replies()).toEqual([
            expect.objectContaining({
                status: 'error',
                error: expect.objectContaining({ code: 'rate_limited' }),
            }),
        ])

        finish[0]?.()
        await running[0]
        const next = send(unknownEvent(101))
        await vi.waitFor(() => {
            expect(wsSessionHandler).toHaveBeenCalledTimes(MAX_CONCURRENT + 1)
        })
        finish.slice(1).forEach((done) => {
            done()
        })
        await Promise.all([...running, next])
    })

    it('frees the handler slot when the handler throws', async () => {
        const { send } = createConnection()
        wsApiHandler.mockRejectedValue(new Error('boom'))

        for (let n = 1; n <= MAX_CONCURRENT + 2; n += 1) await send(unknownEvent(n))

        expect(wsSessionHandler).toHaveBeenCalledTimes(MAX_CONCURRENT + 2)
    })
})

describe('WS connection that keeps flooding', () => {
    it('is closed once it sent more than twice the budget in a minute, and nothing is answered after', async () => {
        const { ws, send } = createConnection()

        for (let n = 1; n <= 2 * BUDGET; n += 1) await send(unknownEvent(n))
        expect(ws.end).not.toHaveBeenCalled()

        await send(unknownEvent(2 * BUDGET + 1))
        expect(ws.end).toHaveBeenCalledTimes(1)
        expect(ws.end).toHaveBeenCalledWith(WS_CLOSE_MESSAGE_FLOOD, expect.any(String))
        expect(WS_CLOSE_MESSAGE_FLOOD).toBeGreaterThanOrEqual(4000)
        expect(WS_CLOSE_MESSAGE_FLOOD).toBeLessThan(4100)
        expect(WS_CLOSE_MESSAGE_FLOOD).not.toBe(4001)
    })

    it('is closed in the third minute in a row that went over the budget', async () => {
        vi.useFakeTimers({ now: 2_000_000 })
        const { ws, send } = createConnection()

        for (let minute = 0; minute < 2; minute += 1) {
            vi.setSystemTime(2_000_000 + minute * 60_000)
            for (let n = 1; n <= BUDGET + 1; n += 1) await send(unknownEvent(n))
        }
        expect(ws.end).not.toHaveBeenCalled()

        vi.setSystemTime(2_000_000 + 2 * 60_000)
        for (let n = 1; n <= BUDGET + 1; n += 1) await send(unknownEvent(n))

        expect(ws.end).toHaveBeenCalledTimes(1)
    })

    it('forgets earlier minutes over the budget after a minute within it', async () => {
        vi.useFakeTimers({ now: 3_000_000 })
        const { ws, send } = createConnection()
        const overBudgetMinute = async (minute: number): Promise<void> => {
            vi.setSystemTime(3_000_000 + minute * 60_000)
            for (let n = 1; n <= BUDGET + 1; n += 1) await send(unknownEvent(n))
        }

        await overBudgetMinute(0)
        await overBudgetMinute(1)
        vi.setSystemTime(3_000_000 + 2 * 60_000)
        await send(unknownEvent(1))
        await overBudgetMinute(3)

        expect(ws.end).not.toHaveBeenCalled()
    })
})
