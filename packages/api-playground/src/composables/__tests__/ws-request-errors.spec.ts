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

/** The id of the request sent last: a reply carries it back (feat-180). */
const lastId = (): string | undefined => {
    const data = send.mock.lastCall?.[0] as string | undefined
    return data === undefined ? undefined : (JSON.parse(data) as { id?: string }).id
}

/** A reply to the last request: its id unless the message names one. */
const reply = (message: Record<string, unknown>): void => {
    const withId = 'id' in message ? message : { id: lastId(), ...message }
    ;(fake.options as Options).onMessage(null, { data: JSON.stringify(withId) })
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
        expect(rejected.reply).toEqual({ ...errorReply, id: expect.any(String) })
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

// feat-180 (ADR 0006, Д-WS1): a reply is matched by the request's id, not by its event.
describe('playground websocketApi: correlation by id', () => {
    it('two requests of one event are in flight together and each gets its own reply', async () => {
        const connection = useWebSocketConnection()
        const one = outcomeOf(connection.websocketApi('api/same', { n: 1 }))
        const firstId = lastId()
        const two = outcomeOf(connection.websocketApi('api/same', { n: 2 }))
        const secondId = lastId()
        expect(firstId).toBeDefined()
        expect(firstId).not.toBe(secondId)

        reply({ event: 'api/same', id: secondId, status: '200', data: { n: 2 }, error: null })
        reply({ event: 'api/same', id: firstId, status: '200', data: { n: 1 }, error: null })
        await vi.advanceTimersByTimeAsync(0)

        expect(await one).toEqual({ resolved: expect.objectContaining({ data: { n: 1 } }) })
        expect(await two).toEqual({ resolved: expect.objectContaining({ data: { n: 2 } }) })
    })
})
