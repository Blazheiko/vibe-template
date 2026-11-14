import { beforeEach, describe, expect, it, vi } from 'vitest'

// feat-186: the transport calls main/init itself (the session refresh cannot go through callApi,
// which waits for it), but the path and the method are the ones of `mainContracts.init`. Here
// the contract is moved: the transport has to follow it, with no second copy of the route.

const TOKEN_U1 = 'a'.repeat(43)
const TOKEN_ANON = 'c'.repeat(43)
const TOKEN_U1_FRESH = 'd'.repeat(43)
const MOVED = '/api/session/current'

vi.mock('shared/contracts', async (importOriginal) => {
    const original = await importOriginal<typeof import('shared/contracts')>()
    return {
        ...original,
        mainContracts: {
            ...original.mainContracts,
            init: { ...original.mainContracts.init, path: '/session/current' },
        },
    }
})
vi.mock('@/composables/useWebSocketConnection', () => ({
    useWebSocketConnection: () => ({ websocketApi: vi.fn() }),
}))
vi.mock('../event-bus', () => ({ useEventBus: () => ({ emit: vi.fn() }) }))

const json = (payload: unknown, status = 200): Response =>
    new Response(JSON.stringify(payload), {
        status,
        headers: { 'Content-Type': 'application/json' },
    })

const serve = (byUrl: (url: string) => Response) => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>((url) =>
        Promise.resolve(byUrl(url)),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch
    return fetchMock
}

const load = async () => {
    const csrf = await import('../csrf-token')
    csrf.confirmCsrfToken(TOKEN_U1, '1')
    const module = await import('../base-api')
    module.setRefreshTimeout(50)
    module.setReloadHandler(vi.fn())
    module.setCurrentUserIdProvider(() => '1')
    return { api: module.default, csrf }
}

describe('base-api follows the contract of main/init', () => {
    beforeEach(() => {
        vi.resetModules()
        vi.spyOn(console, 'error').mockImplementation(() => undefined)
    })

    it('refreshes the session at the path and with the method of the contract', async () => {
        let mismatched = false
        const server = serve((url) => {
            if (url.endsWith(MOVED))
                return json({ status: 'ok', user: { id: '1' }, csrfToken: TOKEN_U1_FRESH })
            if (!mismatched) {
                mismatched = true
                return json(
                    {
                        status: 'error',
                        code: 'csrf_invalid',
                        reason: 'token_mismatch',
                        message: 'x',
                    },
                    403,
                )
            }
            return json({ status: 'success' })
        })
        const { api } = await load()

        await api.http('POST', '/api/test')

        const refresh = server.mock.calls.filter(([url]) => url.endsWith(MOVED))
        expect(refresh).toHaveLength(1)
        expect(refresh[0]?.[1]?.method).toBe('GET')
        expect(server.mock.calls.some(([url]) => url.endsWith('/api/main/init'))).toBe(false)
    })

    it('takes the token of a call to the moved route as the one of init', async () => {
        serve(() =>
            json(
                {
                    status: 'error',
                    code: 'unauthorized',
                    message: 'No session',
                    csrfToken: TOKEN_ANON,
                },
                401,
            ),
        )
        const { api, csrf } = await load()

        await api.http('GET', MOVED)

        expect(csrf.getCsrfToken()).toBe(TOKEN_ANON)
    })
})
