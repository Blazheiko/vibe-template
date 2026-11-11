import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'

// feat-158: what the playground makes of a reply to a WS request. The backend answers
// `{ status: '200', data }` or `{ status: 'error', error: { code, message, details }, data: null }`;
// the old handler read `payload.message`, threw on a reply without `payload`, and the request
// then sat until its timeout — which the form showed as a green 200.

interface Options {
    onMessage: (socket: unknown, event: { data: string }) => void
}

const fake = vi.hoisted(() => {
    const state: { options: unknown } = { options: undefined }
    return state
})
const status = ref<'OPEN' | 'CLOSED' | 'CONNECTING'>('OPEN')
const send = vi.fn()
vi.mock('@vueuse/core', () => ({
    useWebSocket: (_url: unknown, options: unknown) => {
        fake.options = options
        return { status, send, close: vi.fn(), open: vi.fn(), ws: ref(null) }
    },
    useIntervalFn: () => ({ pause: vi.fn(), resume: vi.fn() }),
}))

const { useWebSocketConnection, WsRequestError } = await import('../useWebSocketConnection')

const reply = (message: Record<string, unknown>): void => {
    ;(fake.options as Options).onMessage(null, { data: JSON.stringify(message) })
}

/** The outcome of a request once it settles: the reply, or the error it was rejected with. */
const outcomeOf = (request: Promise<unknown>): Promise<unknown> =>
    request.then(
        (value) => ({ resolved: value }),
        (error: unknown) => ({ rejected: error }),
    )

beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('window', globalThis)
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    status.value = 'OPEN'
})

afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

describe('playground websocketApi', () => {
    it('resolves with a 200 reply', async () => {
        const request = outcomeOf(useWebSocketConnection().websocketApi('api/ok', {}))
        reply({ event: 'api/ok', status: '200', data: { value: 1 }, error: null })
        await vi.advanceTimersByTimeAsync(0)

        expect(await request).toEqual({
            resolved: expect.objectContaining({ event: 'api/ok', data: { value: 1 } }),
        })
    })

    it('rejects at once with the code and message of an error reply', async () => {
        const request = outcomeOf(useWebSocketConnection().websocketApi('api/refused', {}))
        const errorReply = {
            event: 'api/refused',
            status: 'error',
            data: null,
            error: {
                code: 'validation_failed',
                message: 'Validation failure',
                details: { kind: 'validation', messages: ['name is required'] },
            },
        }
        reply(errorReply)
        await vi.advanceTimersByTimeAsync(0)

        const { rejected } = (await request) as { rejected: InstanceType<typeof WsRequestError> }
        expect(rejected).toBeInstanceOf(WsRequestError)
        expect(rejected.message).toBe('Validation failure')
        expect(rejected.code).toBe('validation_failed')
        expect(rejected.status).toBe('error')
        expect(rejected.reply).toEqual(errorReply)
    })

    it('rejects with a timeout when no reply comes', async () => {
        const request = outcomeOf(useWebSocketConnection().websocketApi('api/silent', {}))
        await vi.advanceTimersByTimeAsync(10_000)

        const { rejected } = (await request) as { rejected: InstanceType<typeof WsRequestError> }
        expect(rejected).toBeInstanceOf(WsRequestError)
        expect(rejected.message).toBe('Request timeout')
        expect(rejected.status).toBe(408)
    })
})
