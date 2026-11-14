import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'

// feat-165 (review 2026-11-10): the token goes to the server as the WebSocket subprotocol. With
// no token the list was [''], and `new WebSocket(url, [''])` throws a SyntaxError: a connection
// to an endpoint that needs no token could not be opened from the playground.

const captured = vi.hoisted(() => ({ protocols: undefined as string[] | undefined }))
const open = vi.hoisted(() => vi.fn())
vi.mock('@vueuse/core', () => ({
    useWebSocket: (_url: unknown, options: { protocols?: string[] }) => {
        captured.protocols = options.protocols
        return { status: ref('CLOSED'), send: vi.fn(), close: vi.fn(), open, ws: ref(null) }
    },
    useIntervalFn: () => ({ pause: vi.fn(), resume: vi.fn() }),
}))

const { useWebSocketConnection } = await import('../useWebSocketConnection')

/** What the WebSocket constructor does with the list it is given. */
const assertValidSubprotocols = (protocols: string[]): void => {
    for (const protocol of protocols) {
        if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(protocol)) {
            throw new SyntaxError(`The subprotocol '${protocol}' is invalid.`)
        }
    }
}

describe('playground websocketOpen: the token as a subprotocol', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        vi.spyOn(console, 'log').mockImplementation(() => undefined)
    })

    it('has no subprotocol before a connection is asked for', () => {
        expect(captured.protocols).toEqual([])
    })

    it('opens without a subprotocol when the token is empty', () => {
        useWebSocketConnection().websocketOpen('ws://127.0.0.1:3000/api/websocket', '')

        expect(open).toHaveBeenCalledTimes(1)
        expect(captured.protocols).toEqual([])
        expect(() => {
            assertValidSubprotocols(captured.protocols ?? [''])
        }).not.toThrow()
    })

    it('sends the token as the one subprotocol', () => {
        useWebSocketConnection().websocketOpen('ws://127.0.0.1:3000/api/websocket', 'tok123')

        expect(captured.protocols).toEqual(['tok123'])
    })

    it('forgets the token of the previous connection', () => {
        const connection = useWebSocketConnection()
        connection.websocketOpen('ws://127.0.0.1:3000/api/websocket', 'tok123')
        connection.websocketOpen('ws://127.0.0.1:3000/api/websocket', '')

        expect(captured.protocols).toEqual([])
    })
})
