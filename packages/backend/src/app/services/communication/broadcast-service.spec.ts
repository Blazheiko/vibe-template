import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { BroadcastEventName, BroadcastMessage, BroadcastPayload } from 'shared/schemas'
import type * as ValidateResponse from '#vendor/utils/validation/validate-response.js'

const error = vi.fn()
const warn = vi.fn()
const logger = { error, warn, info: vi.fn(), debug: vi.fn() }
vi.mock('#logger', () => ({ default: logger }))
vi.mock('#vendor/utils/logger.js', () => ({ default: logger }))
vi.mock('#app/services/observability/sentry-service.js', () => ({
    sentryService: { captureMessage: vi.fn() },
}))

const broadcastToChannel = vi.fn((..._args: unknown[]) => true)
vi.mock('#vendor/start/server.js', () => ({ broadcastToChannel }))

const send = vi.fn((_message: string) => 1)
const end = vi.fn()
const connections = ['a', 'b', 'c']
vi.mock('#app/websocket/ws-connection-registry.js', () => ({
    wsConnectionRegistry: {
        forEachConnection: (
            _userId: string,
            fn: (ws: { send: typeof send }, uuid: string) => void,
        ) => {
            for (const uuid of connections)
                fn({ send, end, getBufferedAmount: () => 0 } as never, uuid)
        },
        getConnection: (_userId: string, uuid: string) =>
            connections.includes(uuid) ? { send, end, getBufferedAmount: () => 0 } : undefined,
    },
}))

// Counts runs of the per-event check built by the real createResponseCheck.
const checkRuns = vi.fn()
vi.mock('#vendor/utils/validation/validate-response.js', async (importOriginal) => {
    const actual = await importOriginal<typeof ValidateResponse>()
    return {
        ...actual,
        createResponseCheck: (...args: Parameters<typeof actual.createResponseCheck>) => {
            const check = actual.createResponseCheck(...args)
            return check === null
                ? null
                : (...run: Parameters<NonNullable<typeof check>>) => {
                      checkRuns(run[1].route)
                      return check(...run)
                  }
        },
    }
})

vi.stubEnv('APP_KEY', 'a'.repeat(32))

const { createBroadcastService } = await import('./broadcast-service.js')
const { __resetResponseValidationLog } =
    await import('#vendor/utils/validation/validate-response.js')

const upsert = {
    id: '42',
    name: 'Ada',
    email: 'ada@example.test',
    appType: 'web' as const,
    userAgent: 'Mozilla/5.0',
    connectionsCount: 1,
}

const sentPayloads = (): unknown[] =>
    send.mock.calls.map(([message]) => (JSON.parse(message) as { payload: unknown }).payload)

beforeEach(() => {
    __resetResponseValidationLog()
})

afterEach(() => {
    vi.clearAllMocks()
    vi.restoreAllMocks()
})

describe('broadcastService types (feat-049 §4.2)', () => {
    it('rejects an unknown event and the payload of another event at compile time', () => {
        const service = createBroadcastService({ mode: 'strict' })
        // @ts-expect-error not a broadcast event
        service.broadcastMessageToUser('1', 'support_chat_unknown', { token: 'x' })
        // @ts-expect-error payload of support_chat_error
        service.broadcastMessageToUser('1', 'support_chat_token', { message: 'x' })
        expect(send).not.toHaveBeenCalled()
    })

    it('keeps the event and its payload linked for union arguments', () => {
        const service = createBroadcastService({ mode: 'strict' })
        const relay = (
            event: BroadcastEventName,
            payload: BroadcastPayload<BroadcastEventName>,
        ): number =>
            // @ts-expect-error a union of names with a union of payloads is not a BroadcastMessage
            service.broadcastMessageToUser('1', event, payload)
        expect(relay('support_chat_token', { message: 'wrong payload' })).toBe(0)
        const message: BroadcastMessage = ['support_chat_token', { token: 'ok' }]
        expect(service.broadcastMessageToUser('1', ...message)).toBe(3)
    })
})

describe.each(['strict', 'log'] as const)('broadcastService in %s mode', (mode) => {
    const service = createBroadcastService({ mode })

    it('sends a valid event to every connection', () => {
        expect(service.broadcastMessageToUser('1', 'support_chat_token', { token: 'hi' })).toBe(3)
        expect(sentPayloads()).toEqual([{ token: 'hi' }, { token: 'hi' }, { token: 'hi' }])
        expect(JSON.parse(send.mock.calls[0]![0]).event).toBe('broadcast:support_chat_token')
        expect(error).not.toHaveBeenCalled()
    })

    it('drops a payload that does not match the schema', () => {
        const payload = { content: 'done', screenshots: [1] } as unknown as {
            content: string
            screenshots: string[]
        }
        expect(service.broadcastMessageToUser('1', 'support_chat_complete', payload)).toBe(0)
        expect(send).not.toHaveBeenCalled()
        expect(error).toHaveBeenCalledWith(
            { event: 'support_chat_complete' },
            'Broadcast event dropped: payload breaks its schema',
        )
    })

    it('checks the payload once per event, not per connection', () => {
        service.broadcastMessageToUser('1', 'support_chat_token', { token: 'x' })
        expect(send).toHaveBeenCalledTimes(3)
        expect(checkRuns.mock.calls).toEqual([['support_chat_token']])
        // Every connection gets the one serialized message.
        expect(new Set(send.mock.calls.map(([message]) => message)).size).toBe(1)
    })

    it('publishes a checked message to a channel', () => {
        expect(service.broadcastMessageToChannel('admin', 'admin_user_online_upsert', upsert)).toBe(
            true,
        )
        const [channel, event, message] = broadcastToChannel.mock.calls[0]!
        expect([channel, event]).toEqual(['admin', 'admin_user_online_upsert'])
        expect(JSON.parse(message as string).payload).toEqual(upsert)
    })

    it('does not publish a channel event that breaks the schema', () => {
        const payload = { id: 'abc' }
        expect(
            service.broadcastMessageToChannel('admin', 'admin_user_online_remove', payload),
        ).toBe(false)
        expect(broadcastToChannel).not.toHaveBeenCalled()
    })

    it('sends to one target connection', () => {
        expect(
            service.broadcastMessageToUserConnection('1', 'b', 'support_chat_error', {
                message: 'x',
            }),
        ).toBe(1)
        expect(sentPayloads()).toEqual([{ message: 'x' }])
    })
})

describe('undeclared keys follow the response mode (feat-049 §4.3)', () => {
    const extra = { ...upsert, password: 'secret' }

    it('strict: the event is not sent', () => {
        const service = createBroadcastService({ mode: 'strict' })
        expect(
            service.broadcastMessageToUserExcept('1', 'a', 'admin_user_online_upsert', extra),
        ).toBe(0)
        expect(send).not.toHaveBeenCalled()
        expect(error).toHaveBeenCalled()
    })

    it('log: the event is sent without the key, with a warn naming the path', () => {
        const service = createBroadcastService({ mode: 'log' })
        expect(
            service.broadcastMessageToUserExcept('1', 'a', 'admin_user_online_upsert', extra),
        ).toBe(2)
        expect(sentPayloads()).toEqual([upsert, upsert])
        expect(warn).toHaveBeenCalledWith(
            expect.objectContaining({
                route: 'admin_user_online_upsert',
                transport: 'broadcast',
                issues: [expect.objectContaining({ path: 'password', code: 'undeclared_key' })],
            }),
            expect.any(String),
        )
    })
})

// feat-124 (L9): uWS send 1 = sent, 0 = buffered (still goes out), 2 = dropped.
const ping = (): BroadcastMessage => ['support_chat_token', { token: 'hi' }]

describe('send results (feat-124)', () => {
    afterEach(() => {
        send.mockReset()
        send.mockImplementation(() => 1)
        end.mockClear()
    })

    it('counts a buffered message as delivered', () => {
        send.mockImplementation(() => 0)
        const service = createBroadcastService({ mode: 'log' })

        expect(service.broadcastMessageToUserConnection('7', 'a', ...ping())).toBe(1)
        expect(service.broadcastMessageToUser('7', ...ping())).toBe(3)
        expect(end).not.toHaveBeenCalled()
    })

    it('ends a connection that dropped the event, and does not count it', () => {
        send.mockImplementationOnce(() => 2).mockImplementation(() => 1)
        const service = createBroadcastService({ mode: 'log' })

        expect(service.broadcastMessageToUser('7', ...ping())).toBe(2)
        expect(end).toHaveBeenCalledTimes(1)
        expect(end).toHaveBeenCalledWith(1013, 'Backpressure')
    })
})
