import { beforeEach, describe, expect, it, vi } from 'vitest'

// feat-254: the logout names this browser's push endpoint; the server deletes its record with the
// session. Without one the body stays empty.

vi.mock('@/composables/useWebSocketConnection', () => ({
    useWebSocketConnection: () => ({
        websocketApi: vi.fn(),
    }),
}))

vi.mock('../event-bus', () => ({
    useEventBus: () => ({
        emit: vi.fn(),
    }),
}))

const sentBody = (fetchMock: ReturnType<typeof vi.fn>): unknown => {
    const init = fetchMock.mock.lastCall?.[1] as RequestInit | undefined
    return JSON.parse(typeof init?.body === 'string' ? init.body : '')
}

describe('api.logout', () => {
    let fetchMock: ReturnType<typeof vi.fn>

    beforeEach(() => {
        vi.resetModules()
        fetchMock = vi.fn().mockImplementation(() =>
            Promise.resolve(
                new Response(JSON.stringify({ status: 'success', csrfToken: 'c'.repeat(43) }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            ),
        )
        globalThis.fetch = fetchMock as typeof fetch
    })

    it('sends the push endpoint it is given', async () => {
        const { authApi } = await import('../api')

        await authApi.logout('https://fcm.googleapis.com/fcm/send/x')

        expect(String(fetchMock.mock.lastCall?.[0])).toMatch(/\/auth\/logout$/)
        expect(sentBody(fetchMock)).toEqual({
            pushEndpoint: 'https://fcm.googleapis.com/fcm/send/x',
        })
    })

    it('sends an empty body without one', async () => {
        const { authApi } = await import('../api')

        await authApi.logout(null)

        expect(sentBody(fetchMock)).toEqual({})
    })
})
