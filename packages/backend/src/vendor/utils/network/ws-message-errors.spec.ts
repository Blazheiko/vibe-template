import { beforeEach, describe, expect, it, vi } from 'vitest'

// Error replies of onMessage (feat-087): one classification for every failure, the
// request's event kept, a malformed message treated as a client error.
const logger = vi.hoisted(() => ({ debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() }))
vi.mock('#vendor/utils/logger.js', () => ({ default: logger }))
vi.mock('#database/redis-rate-limit.js', () => ({ default: { eval: vi.fn() } }))
const wsApiHandler = vi.hoisted(() => vi.fn())
vi.mock('../routing/ws-api-dispatcher.js', () => ({ default: wsApiHandler }))
const wsSessionHandler = vi.hoisted(() => vi.fn())
vi.mock('../session/session-handler.js', () => ({ wsSessionHandler }))

const validate = vi.fn()
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
    onUpgrade: vi.fn(),
    onConnected: vi.fn(),
    onDisconnected: vi.fn(),
})
handlers.registerWsMessageValidator({ validate: (value: unknown) => validate(value) as never })

const createWs = () => {
    const sent: string[] = []
    return {
        sent,
        getUserData: () => ({ token: 'wstoken', sessionId: 's1', userToken: 'u1', userId: '1' }),
        cork: (cb: () => void) => {
            cb()
        },
        send: vi.fn((data: string) => sent.push(data)),
        end: vi.fn(),
        close: vi.fn(),
    }
}

const message = (text: string): ArrayBuffer => {
    const bytes = new TextEncoder().encode(text)
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
}

const send = async (text: string) => {
    const ws = createWs()
    await handlers.onMessage(ws as never, message(text), false, ROUTES)
    expect(ws.sent).toHaveLength(1)
    return JSON.parse(ws.sent[0] ?? '') as Record<string, unknown>
}

beforeEach(() => {
    vi.clearAllMocks()
    validate.mockImplementation((value: unknown) => ({ ok: true, value }))
    wsSessionHandler.mockResolvedValue({ kind: 'ok', session: {} })
})

describe('onMessage error replies', () => {
    it('answers malformed JSON with bad_request at warn, never error (Sentry)', async () => {
        const reply = await send('{not json')

        expect(reply).toMatchObject({
            status: 'error',
            data: null,
            event: '',
            error: { code: 'bad_request', message: 'Malformed json body' },
        })
        expect(logger.warn).toHaveBeenCalledWith({ bodyKind: 'json' }, 'Malformed request body')
        expect(logger.error).not.toHaveBeenCalled()
        expect(wsApiHandler).not.toHaveBeenCalled()
    })

    it('answers an invalid message with the event and timestamp of the request', async () => {
        validate.mockReturnValue({
            ok: false,
            messages: ['payload must be an object'],
            issues: [{ path: 'payload', message: 'must be an object' }],
        })

        const reply = await send(JSON.stringify({ event: 'support:chat', timestamp: 42 }))

        expect(reply).toMatchObject({
            status: 'error',
            data: null,
            event: 'support:chat',
            timestamp: 42,
            error: {
                code: 'validation_failed',
                message: 'Validation failure',
                details: {
                    kind: 'validation',
                    messages: ['payload must be an object'],
                    issues: [{ path: 'payload', message: 'must be an object' }],
                },
            },
        })
        expect(logger.error).not.toHaveBeenCalled()
    })

    it('leaves event and timestamp empty when they have the wrong type', async () => {
        validate.mockReturnValue({ ok: false, messages: ['bad'] })

        const reply = await send(JSON.stringify({ event: 7, timestamp: 'x' }))

        expect(reply).toMatchObject({ event: '', timestamp: 0 })
    })

    it('answers an unexpected failure with internal_error and logs it as error', async () => {
        wsSessionHandler.mockRejectedValue(new Error('boom'))

        const reply = await send(JSON.stringify({ event: 'user:me', timestamp: 5 }))

        expect(reply).toMatchObject({
            status: 'error',
            event: 'user:me',
            timestamp: 5,
            error: { code: 'internal_error', message: 'Internal server error' },
        })
        expect(logger.error).toHaveBeenCalledTimes(1)
    })
})

// feat-180 (ADR 0006, Д-WS1): an error reply built before the dispatcher carries the request's
// `id` too, or the client's request would wait until its timeout.
describe('onMessage error replies keep the request id', () => {
    it('on an invalid message', async () => {
        validate.mockReturnValue({ ok: false, messages: ['bad'] })

        const reply = await send(
            JSON.stringify({ event: 'support:chat', id: 'req-1', timestamp: 4 }),
        )

        expect(reply).toMatchObject({ id: 'req-1', error: { code: 'validation_failed' } })
    })

    it('on an unexpected failure', async () => {
        wsSessionHandler.mockRejectedValue(new Error('boom'))

        const reply = await send(JSON.stringify({ event: 'user:me', id: 'req-2', timestamp: 5 }))

        expect(reply).toMatchObject({ id: 'req-2', error: { code: 'internal_error' } })
    })

    it('on Redis unavailable for the session', async () => {
        wsSessionHandler.mockResolvedValue({ kind: 'unavailable' })

        const reply = await send(
            JSON.stringify({ event: 'user:me', id: 'req-3', timestamp: 6, payload: {} }),
        )

        expect(reply).toMatchObject({ id: 'req-3', error: { code: 'service_unavailable' } })
    })

    it('not an id that is not a string', async () => {
        validate.mockReturnValue({ ok: false, messages: ['bad'] })

        const reply = await send(JSON.stringify({ event: 'user:me', id: 42, timestamp: 7 }))

        expect('id' in reply).toBe(false)
    })
})
