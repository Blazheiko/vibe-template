import { beforeEach, describe, expect, it, vi } from 'vitest'

// feat-149 (review 2026-11-10, M1): a connection has a budget of messages a minute, checked
// before anything that costs a Redis command or a PostgreSQL query. The counter below is that
// cost: wsSessionHandler reads the session from Redis and the session token from PostgreSQL.
// feat-196: the WS token is consumed by the upgrade, so a message no longer refreshes it.
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
const { WS_PINGS_PER_MINUTE, WS_CLOSE_MESSAGE_FLOOD } =
    await import('../rate-limit/ws-message-budget.js')
handlers.registerWsAppHooks({
    onUpgrade: vi.fn(),
    onConnected: vi.fn(),
    onDisconnected: vi.fn(),
})
handlers.registerWsMessageValidator({
    validate: (value: unknown) => ({ ok: true, value }) as never,
})

const BUDGET = 20
const MAX_CONCURRENT = 3

/** One connection: uWS hands out the same user data object for the life of the socket. */
const createConnection = () => {
    const sent: string[] = []
    const userData = { sessionId: 's1', userToken: 'u1', userId: '1' }
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
            ROUTES,
        )
    }
    const replies = (): Record<string, unknown>[] =>
        sent.filter((text) => text !== 'pong').map((text) => JSON.parse(text) as never)
    return { ws, send, replies }
}

const unknownEvent = (n: number): string =>
    JSON.stringify({ event: 'some/route', timestamp: n, payload: null })

beforeEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
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

// feat-197 (M-4): an event no route answers cost a session read (a Redis command and a query on
// the pool the HTTP session checks share) and no route limit applied to it.
describe('an event no route answers', () => {
    const noSuchRoute = (n: number, id?: string): string =>
        JSON.stringify({
            event: 'no/such/route:x',
            timestamp: n,
            payload: null,
            ...(id !== undefined ? { id } : {}),
        })

    it('is answered not_found without reading the session or reaching the dispatcher', async () => {
        const { ws, send, replies } = createConnection()

        await send(noSuchRoute(7, 'req-7'))

        expect(wsSessionHandler).not.toHaveBeenCalled()
        expect(wsApiHandler).not.toHaveBeenCalled()
        expect(replies()).toEqual([
            {
                event: 'no/such/route:x',
                id: 'req-7',
                status: 'error',
                data: null,
                timestamp: 7,
                error: expect.objectContaining({ code: 'not_found' }),
            },
        ])
        expect(ws.end).not.toHaveBeenCalled()
    })

    it('does not treat an inherited property as a route', async () => {
        const { send, replies } = createConnection()

        await send(JSON.stringify({ event: 'constructor', timestamp: 1, payload: null }))

        expect(wsSessionHandler).not.toHaveBeenCalled()
        expect(replies()[0]).toMatchObject({ error: { code: 'not_found' } })
    })

    it('still counts against the message budget', async () => {
        const { send, replies } = createConnection()

        for (let n = 1; n <= BUDGET + 1; n += 1) await send(noSuchRoute(n))

        expect(wsSessionHandler).not.toHaveBeenCalled()
        expect(replies()[BUDGET]).toMatchObject({ error: { code: 'rate_limited' } })
    })
})

// feat-197 (L-11): binary frames used to return before the budget was looked at.
describe('a binary frame', () => {
    it('closes the connection with 1003 on the first frame, with one warn line', async () => {
        const { ws } = createConnection()

        await handlers.onMessage(ws as never, new ArrayBuffer(8), true, ROUTES)

        expect(ws.end).toHaveBeenCalledTimes(1)
        expect(ws.end).toHaveBeenCalledWith(1003, 'Binary frames are not supported')
        expect(logger.warn).toHaveBeenCalledTimes(1)
        expect(logger.error).not.toHaveBeenCalled()
        expect(wsSessionHandler).not.toHaveBeenCalled()
        expect(ws.send).not.toHaveBeenCalled()
    })

    it('touches nothing when the socket has closed already', async () => {
        const { ws } = createConnection()
        ;(ws.getUserData() as { closed?: boolean }).closed = true

        await handlers.onMessage(ws as never, new ArrayBuffer(8), true, ROUTES)

        expect(ws.end).not.toHaveBeenCalled()
        expect(logger.warn).not.toHaveBeenCalled()
    })
})

describe('WS message budget of a connection', () => {
    it('checks the session for valid messages only until the budget is used up', async () => {
        const { send, replies } = createConnection()

        for (let n = 1; n <= BUDGET + 10; n += 1) await send(unknownEvent(n))

        expect(wsSessionHandler).toHaveBeenCalledTimes(BUDGET)
        expect(replies().filter((reply) => reply['status'] === 'error')).toHaveLength(BUDGET + 10)
        expect(replies()[BUDGET]).toMatchObject({
            status: 'error',
            data: null,
            event: 'some/route',
            error: { code: 'rate_limited' },
        })
    })

    it('never checks the session for malformed JSON, and refuses it over the budget', async () => {
        const { send, replies } = createConnection()

        for (let n = 1; n <= BUDGET + 10; n += 1) await send('{not json')

        expect(wsSessionHandler).not.toHaveBeenCalled()
        expect(replies()[BUDGET]).toMatchObject({
            status: 'error',
            event: '',
            error: { code: 'rate_limited' },
        })
    })

    it('never checks the session for ping and always answers pong', async () => {
        const { ws, send } = createConnection()

        for (let n = 1; n <= WS_PINGS_PER_MINUTE + 10; n += 1) await send('ping')

        expect(wsSessionHandler).not.toHaveBeenCalled()
        expect(ws.sent.filter((text) => text === 'pong')).toHaveLength(WS_PINGS_PER_MINUTE + 10)
    })

    it('keeps the ping budget apart: a used-up message budget does not stop the heartbeat', async () => {
        const { ws, send } = createConnection()
        for (let n = 1; n <= BUDGET + 1; n += 1) await send(unknownEvent(n))

        await send('ping')

        expect(ws.sent.filter((text) => text === 'pong')).toHaveLength(1)
        expect(ws.end).not.toHaveBeenCalled()
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

// Review 2026-11-12 (feat-185): the early refusal answers the request's id like every other
// reply (ADR 0006, feat-180); without it the client cannot match it and waits for its timeout.
describe('early refusal keeps the request id', () => {
    const withId = (n: number, id: unknown): string =>
        JSON.stringify({ event: 'some/route', id, timestamp: n, payload: null })

    it('over the message budget', async () => {
        const { send, replies } = createConnection()
        for (let n = 1; n <= BUDGET; n += 1) await send(unknownEvent(n))

        await send(withId(BUDGET + 1, 'req-over-budget'))

        expect(replies()[BUDGET]).toMatchObject({
            event: 'some/route',
            id: 'req-over-budget',
            error: { code: 'rate_limited' },
        })
    })

    it('over the concurrent handlers, and not an id the envelope does not allow', async () => {
        const { send, replies } = createConnection()
        const finish: (() => void)[] = []
        wsApiHandler.mockImplementation(
            (message: { event: string }) =>
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

        await send(withId(100, 'req-busy'))
        await send(withId(101, 'x'.repeat(65)))
        await send(withId(102, 7))

        const [busy, tooLong, notText] = replies()
        expect(busy).toMatchObject({ id: 'req-busy', error: { code: 'rate_limited' } })
        expect(tooLong).not.toHaveProperty('id')
        expect(notText).not.toHaveProperty('id')

        finish.forEach((done) => {
            done()
        })
        await Promise.all(running)
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
