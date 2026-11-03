import { beforeEach, describe, expect, it, vi } from 'vitest'

// feat-097: the new OAuth endpoints, and a 401 `session_revoked` (a claim of the account
// rotated its session) handled like any lost session.

const emitMock = vi.hoisted(() => vi.fn())
const TOKEN = 'a'.repeat(43)

vi.mock('@/composables/useWebSocketConnection', () => ({
    useWebSocketConnection: () => ({ websocketApi: vi.fn() }),
}))
vi.mock('../event-bus', () => ({ useEventBus: () => ({ emit: emitMock }) }))

const jsonResponse = (payload: unknown, status = 200): Response =>
    new Response(JSON.stringify(payload), {
        status,
        headers: { 'Content-Type': 'application/json' },
    })

const sessionRevoked = (): Response =>
    jsonResponse(
        {
            status: 'error',
            code: 'unauthorized',
            message: 'Session is no longer valid',
            reason: 'session_revoked',
        },
        401,
    )

const loadApi = async (user: string | null) => {
    const csrf = await import('../csrf-token')
    csrf.confirmCsrfToken(TOKEN, user)
    const base = await import('../base-api')
    base.setCurrentUserIdProvider(() => user)
    return import('../api')
}

const mockFetch = (reply: () => Response) => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(() =>
        Promise.resolve(reply()),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch
    return fetchMock
}

describe('feat-097 API', () => {
    beforeEach(() => {
        vi.resetModules()
        vi.clearAllMocks()
        vi.spyOn(console, 'error').mockImplementation(() => undefined)
    })

    it('confirms the mailed OAuth link with the token, from an anonymous session', async () => {
        const fetchMock = mockFetch(() => jsonResponse({ status: 'success' }))
        const { authApi } = await loadApi(null)

        const result = await authApi.confirmOAuthLink({ token: 'tok' })

        expect(result).toEqual({ data: { status: 'success' }, error: null })
        const [url, init] = fetchMock.mock.calls[0] ?? []
        expect(url).toMatch(/\/api\/auth\/oauth\/link\/confirm$/)
        expect(init?.method).toBe('POST')
        expect(init?.body).toBe(JSON.stringify({ token: 'tok' }))
        expect((init?.headers as Record<string, string>)['X-CSRF-Token']).toBe(TOKEN)
    })

    it('asks for the confirmation link of the first email again', async () => {
        const fetchMock = mockFetch(() => jsonResponse({ status: 'success', message: 'sent' }))
        const { authApi } = await loadApi('1')

        await authApi.resendOAuthEmailLink()

        expect(fetchMock.mock.calls[0]?.[0]).toMatch(/\/api\/auth\/oauth\/email\/resend$/)
        expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('POST')
    })

    it.each([
        ['change-password', 'changePassword'],
        ['link-phone/confirm', 'confirmPhoneLink'],
        ['logout-all', 'logoutAll'],
    ] as const)('a 401 session_revoked from %s is a lost session', async (_path, method) => {
        mockFetch(sessionRevoked)
        const { authApi } = await loadApi('1')

        const call = authApi[method] as (body: never) => Promise<{ error: unknown }>
        const result = await call({} as never)

        expect(emitMock).toHaveBeenCalledWith('unauthorized')
        expect(result.error).toMatchObject({ code: 'unauthorized', transportCode: 401 })
    })

    it('a 401 session_revoked from the avatar upload is a lost session', async () => {
        mockFetch(sessionRevoked)
        const { avatarApi } = await loadApi('1')

        await avatarApi.upload(new Blob(['x']))

        expect(emitMock).toHaveBeenCalledWith('unauthorized')
    })
})
