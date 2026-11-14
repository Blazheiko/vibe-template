import { beforeEach, describe, expect, it, vi } from 'vitest'

// feat-174: main/* and the support chat history go through their contracts (ADR 0005). The
// request is what the transport gets: the method, the URL and the options of the caller.

vi.mock('@/composables/useWebSocketConnection', () => ({
    useWebSocketConnection: () => ({ websocketApi: vi.fn() }),
}))
vi.mock('../event-bus', () => ({ useEventBus: () => ({ emit: vi.fn() }) }))

const http = vi.hoisted(() => vi.fn())
vi.mock('../base-api', () => ({ default: { http } }))

beforeEach(() => {
    http.mockReset()
    http.mockResolvedValue({ data: { status: 'ok', data: [], hasMore: false }, error: null })
})

describe('main and support calls', () => {
    it('main/init and main/update-ws-token', async () => {
        const { mainApi } = await import('../api')

        await mainApi.init()
        expect(http.mock.lastCall?.slice(0, 2)).toEqual(['GET', '/api/main/init'])
        await mainApi.updateWsToken()
        expect(http.mock.lastCall?.slice(0, 2)).toEqual(['GET', '/api/main/update-ws-token'])
    })

    it('the latest page of the chat history, then the one before a message, with the signal', async () => {
        const { supportApi } = await import('../api')
        const controller = new AbortController()

        await supportApi.getChatHistory({ signal: controller.signal })
        expect(http.mock.lastCall?.slice(0, 2)).toEqual(['GET', '/api/support/chat/history'])
        expect(http.mock.lastCall?.[3]).toEqual({ signal: controller.signal })

        await supportApi.getChatHistory({ before: '812' })
        expect(http.mock.lastCall?.slice(0, 2)).toEqual([
            'GET',
            '/api/support/chat/history?before=812',
        ])
    })

    it('reads a page and tells a failure from an empty conversation', async () => {
        const { supportApi } = await import('../api')
        const message = {
            id: '1',
            role: 'user',
            content: 'hi',
            screenshots: null,
            createdAt: '2026-11-11T00:00:00.000Z',
        }
        http.mockResolvedValueOnce({
            data: { status: 'ok', data: [message], hasMore: true },
            error: null,
        })
        expect(await supportApi.getChatHistory()).toEqual({ messages: [message], hasMore: true })

        http.mockResolvedValueOnce({
            data: { status: 'error', code: 'internal_error', message: 'x' },
            error: { code: 'internal_error', transportCode: 500, message: 'x' },
        })
        expect(await supportApi.getChatHistory()).toBeNull()
    })

    it('deletes the chat history', async () => {
        const { supportApi } = await import('../api')

        expect(await supportApi.deleteChatHistory()).toBe(true)
        expect(http.mock.lastCall?.slice(0, 2)).toEqual(['DELETE', '/api/support/chat/history'])
    })
})
