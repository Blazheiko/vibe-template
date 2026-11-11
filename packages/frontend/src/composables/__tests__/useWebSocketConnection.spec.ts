import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref, shallowRef, watch, type Ref } from 'vue'

// feat-151 (review 2026-11-10, M8): a socket the client closed on purpose — a sign-out, or an
// old socket replaced by a new one — is not a lost connection. vueuse reports every close
// through onDisconnected, also long after the socket stopped being the current one, so the
// composable has to tell them apart. The fake below keeps vueuse's order of events: close()
// drops the current socket at once, the socket's close event arrives later.

interface FakeSocket {
    id: number
    binaryType: string
}

interface Options {
    onConnected: (socket: FakeSocket) => void
    onDisconnected: (socket: FakeSocket, event: { code: number; reason: string }) => void
    onMessage: (socket: FakeSocket, event: { data: string }) => void
}

const fake = vi.hoisted(() => {
    const state: {
        options: unknown
        sockets: { id: number; binaryType: string }[]
        sent: string[]
        opens: number
    } = { options: undefined, sockets: [], sent: [], opens: 0 }
    return state
})

const status = ref<'OPEN' | 'CONNECTING' | 'CLOSED'>('CLOSED')
// Shallow, as a real WebSocket in a ref is: Vue does not wrap it in a proxy.
const ws = shallowRef<FakeSocket | undefined>(undefined)

vi.mock('@vueuse/core', () => ({
    useWebSocket: (url: Ref<string>, options: unknown) => {
        fake.options = options
        const close = (): void => {
            ws.value = undefined
            status.value = 'CLOSED'
        }
        const open = (): void => {
            close()
            fake.opens += 1
            const socket = { id: fake.sockets.length + 1, binaryType: '' }
            fake.sockets.push(socket)
            ws.value = socket
            status.value = 'CONNECTING'
        }
        const send = (data: string): boolean => {
            fake.sent.push(data)
            return true
        }
        // As vueuse does (autoConnect): a new URL opens a socket on the next tick.
        watch(url, open)
        return { status, ws, open, close, send }
    },
}))

const updateWsToken = vi.hoisted(() => vi.fn())
vi.mock('@/utils/api', () => ({ mainApi: { updateWsToken } }))
vi.mock('@/composables/useBroadcastHandler', () => ({
    useBroadcastHandler: () => ({ handleBroadcast: vi.fn() }),
}))
vi.mock('@/utils/sentry-service', () => ({ sentryService: { captureException: vi.fn() } }))
vi.mock('@/utils/sentry-payload-summary', () => ({ reportValidationFailure: vi.fn() }))
vi.mock('@/utils/app-type', () => ({ getCurrentAppType: () => 'web' }))

const URL = 'ws://localhost/ws'

const options = (): Options => fake.options as Options

/** The socket reaches "open", as vueuse reports it. */
const connect = (socket: FakeSocket): void => {
    status.value = 'OPEN'
    options().onConnected(socket)
}

const closeEvent = (code: number) => ({ code, reason: '' })

const currentSocket = (): FakeSocket => {
    if (fake.sockets.length === 0) throw new Error('no socket was opened')
    return fake.sockets[fake.sockets.length - 1]
}

const load = async () => {
    const connection = (await import('../useWebSocketConnection')).useWebSocketConnection()
    return {
        ...connection,
        /** websocketOpen, then the tick on which vueuse opens the socket for a new URL. */
        websocketOpen: async (url: string, token: string): Promise<void> => {
            connection.websocketOpen(url, token)
            await nextTick()
        },
    }
}

beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    vi.clearAllMocks()
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    fake.sockets.length = 0
    fake.sent.length = 0
    fake.opens = 0
    status.value = 'CLOSED'
    ws.value = undefined
    updateWsToken.mockResolvedValue({ data: null, error: { message: 'x', transportCode: 401 } })
})

describe('useWebSocketConnection: a socket closed on purpose', () => {
    it('does not reconnect or refresh the token after websocketClose (a sign-out)', async () => {
        const { websocketOpen, websocketClose } = await load()
        await websocketOpen(URL, 'token-1')
        const socket = currentSocket()
        connect(socket)

        websocketClose()
        options().onDisconnected(socket, closeEvent(1000))
        await vi.advanceTimersByTimeAsync(60_000)

        expect(fake.opens).toBe(1)
        expect(updateWsToken).not.toHaveBeenCalled()
    })

    it('keeps the requests of the new socket when the close of the replaced one arrives', async () => {
        const { websocketOpen, websocketApi } = await load()
        await websocketOpen(URL, 'token-1')
        const first = currentSocket()
        connect(first)

        // A token refresh over a live connection (a password change): same URL, new socket.
        await websocketOpen(URL, 'token-2')
        const second = currentSocket()
        expect(second).not.toBe(first)
        connect(second)

        let settled: 'resolved' | 'rejected' | undefined
        const request = websocketApi('support/chat', { message: 'hi' }).then(
            (reply) => {
                settled = 'resolved'
                return reply
            },
            (error: unknown) => {
                settled = 'rejected'
                throw error
            },
        )
        const { event, id } = JSON.parse(fake.sent[fake.sent.length - 1] ?? '{}') as {
            event: string
            id?: string
        }

        options().onDisconnected(first, closeEvent(1000))
        await vi.advanceTimersByTimeAsync(6000)

        expect(settled).toBeUndefined()
        expect(fake.opens).toBe(2)
        expect(ws.value).toBe(second)

        options().onMessage(second, {
            data: JSON.stringify({ event, id, status: 'ok', payload: { ok: true }, timestamp: 1 }),
        })
        await expect(request).resolves.toMatchObject({ event })
    })

    it('rejects the requests of the old socket at the moment it is replaced', async () => {
        const { websocketOpen, websocketApi } = await load()
        await websocketOpen(URL, 'token-1')
        connect(currentSocket())
        const outcome = websocketApi('support/chat', { message: 'hi' }).then(
            () => 'resolved',
            (error: unknown) => (error instanceof Error ? error.message : String(error)),
        )

        await websocketOpen(URL, 'token-2')

        expect(await outcome).toBe('WebSocket connection reset')
    })

    it('classifies a refused handshake of the new socket on its own, not by the old one', async () => {
        const { websocketOpen } = await load()
        await websocketOpen(URL, 'token-1')
        connect(currentSocket())

        await websocketOpen(URL, 'token-2')
        const second = currentSocket()
        // The new socket never opens: the upgrade was refused (1006 without "open").
        options().onDisconnected(second, closeEvent(1006))
        await vi.advanceTimersByTimeAsync(0)

        expect(updateWsToken).toHaveBeenCalledTimes(1)
    })
})

describe('useWebSocketConnection: a lost connection', () => {
    it('reconnects after 5 seconds when the current socket drops', async () => {
        const { websocketOpen } = await load()
        await websocketOpen(URL, 'token-1')
        const socket = currentSocket()
        connect(socket)

        options().onDisconnected(socket, closeEvent(1006))
        await vi.advanceTimersByTimeAsync(4999)
        expect(fake.opens).toBe(1)
        await vi.advanceTimersByTimeAsync(1)

        expect(fake.opens).toBe(2)
    })

    it('reconnects when the heartbeat closed the socket (no pong): that close is not the app’s', async () => {
        const { websocketOpen } = await load()
        await websocketOpen(URL, 'token-1')
        const socket = currentSocket()
        connect(socket)

        // vueuse's heartbeat calls its own close(): the current socket is dropped, then its
        // close event arrives.
        ws.value = undefined
        status.value = 'CLOSED'
        options().onDisconnected(socket, closeEvent(1000))
        await vi.advanceTimersByTimeAsync(5000)

        expect(fake.opens).toBe(2)
    })

    it('rejects pending requests when the connection is lost', async () => {
        const { websocketOpen, websocketApi } = await load()
        await websocketOpen(URL, 'token-1')
        const socket = currentSocket()
        connect(socket)
        const outcome = websocketApi('support/chat', {}).then(
            () => 'resolved',
            (error: unknown) => (error instanceof Error ? error.message : String(error)),
        )

        options().onDisconnected(socket, closeEvent(1006))

        expect(await outcome).toBe('WebSocket connection reset')
    })
})

// feat-180 (ADR 0006, Д-WS1): a reply is matched to its request by the request's `id`, not by its
// event. Before, a second request of the same event was refused while the first was pending.
describe('useWebSocketConnection: request correlation by id', () => {
    const sentRequests = (): { event: string; id?: string; payload: unknown }[] =>
        fake.sent.map(
            (data) => JSON.parse(data) as { event: string; id?: string; payload: unknown },
        )

    const reply = (socket: FakeSocket, request: { event: string; id?: string }, data: unknown) => {
        options().onMessage(socket, {
            data: JSON.stringify({
                event: request.event,
                ...(request.id !== undefined ? { id: request.id } : {}),
                status: '200',
                error: null,
                data,
                timestamp: 1,
            }),
        })
    }

    it('sends an id with every request, a new one each time', async () => {
        const { websocketOpen, websocketApi } = await load()
        await websocketOpen(URL, 'token-1')
        connect(currentSocket())

        void websocketApi('support/chat', { message: 'a' }).catch(() => undefined)
        void websocketApi('support/open', {}).catch(() => undefined)

        const [first, second] = sentRequests()
        expect(typeof first.id).toBe('string')
        expect(first.id).not.toBe(second.id)
    })

    it('two requests of one event are in flight together and each gets its own reply', async () => {
        const { websocketOpen, websocketApi } = await load()
        await websocketOpen(URL, 'token-1')
        const socket = currentSocket()
        connect(socket)

        const one = websocketApi('support/chat', { message: 'one' })
        const two = websocketApi('support/chat', { message: 'two' })
        const [first, second] = sentRequests()
        expect(first.event).toBe(second.event)

        // The replies come back in the other order.
        reply(socket, second, { answer: 'two' })
        reply(socket, first, { answer: 'one' })

        await expect(one).resolves.toMatchObject({ data: { answer: 'one' } })
        await expect(two).resolves.toMatchObject({ data: { answer: 'two' } })
    })

    it('a reply without the id of a pending request settles nothing', async () => {
        const { websocketOpen, websocketApi } = await load()
        await websocketOpen(URL, 'token-1')
        const socket = currentSocket()
        connect(socket)

        let settled = false
        void websocketApi('support/chat', { message: 'one' }).then(
            () => {
                settled = true
            },
            () => {
                settled = true
            },
        )
        const [request] = sentRequests()

        reply(socket, { event: request.event }, { answer: 'no id' })
        reply(socket, { event: request.event, id: 'someone-else' }, { answer: 'other' })
        await vi.advanceTimersByTimeAsync(0)

        expect(settled).toBe(false)
    })
})
