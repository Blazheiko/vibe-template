import { beforeEach, describe, expect, it, vi } from 'vitest'

// feat-162 (review 2026-11-10): every 401 used to raise `unauthorized`, and App.vue answers
// that with a redirect to /login. A 401 of a request that runs without a session of its own
// (sign-in, registration, a mailed link) is an answer for the form that sent it: a wrong
// password reloaded the login page, and /verify-email lost its "session revoked" explanation.

const emitMock = vi.hoisted(() => vi.fn())
const TOKEN = 'a'.repeat(43)

vi.mock('@/composables/useWebSocketConnection', () => ({
    useWebSocketConnection: () => ({ websocketApi: vi.fn() }),
}))
vi.mock('../event-bus', () => ({ useEventBus: () => ({ emit: emitMock }) }))

const unauthorized = (reason?: string): Response =>
    new Response(
        JSON.stringify({
            status: 'error',
            code: 'unauthorized',
            message: 'Unauthorized',
            ...(reason === undefined ? {} : { reason }),
        }),
        { status: 401, headers: { 'Content-Type': 'application/json' } },
    )

const loadApi = async (user: string | null) => {
    const csrf = await import('../csrf-token')
    csrf.confirmCsrfToken(TOKEN, user)
    const base = await import('../base-api')
    base.setCurrentUserIdProvider(() => user)
    return import('../api')
}

const mockFetch = (reply: () => Response) => {
    globalThis.fetch = vi.fn(() => Promise.resolve(reply()))
}

describe('the unauthorized event', () => {
    beforeEach(() => {
        vi.resetModules()
        vi.clearAllMocks()
        vi.spyOn(console, 'error').mockImplementation(() => undefined)
    })

    it('is not raised by a wrong password on sign-in', async () => {
        mockFetch(() => unauthorized())
        const { authApi } = await loadApi(null)

        const result = await authApi.login({ identifier: 'a@example.com', password: 'wrong-pass' })

        expect(result.error).toMatchObject({ code: 'unauthorized', transportCode: 401 })
        expect(emitMock).not.toHaveBeenCalled()
    })

    it('is not raised by a revoked session on /verify-email: the view explains it', async () => {
        mockFetch(() => unauthorized('session_revoked'))
        const { authApi } = await loadApi('1')

        const result = await authApi.verifyEmail({ token: 'tok' })

        expect(result.error).toMatchObject({ code: 'unauthorized', transportCode: 401 })
        expect(result.data).toMatchObject({ reason: 'session_revoked' })
        expect(emitMock).not.toHaveBeenCalled()
    })

    it('is raised when a request of a signed-in user loses its session', async () => {
        mockFetch(() => unauthorized('session_revoked'))
        const { authApi } = await loadApi('1')

        await authApi.changePassword({ currentPassword: 'old-pass-1', newPassword: 'new-pass-1' })

        expect(emitMock).toHaveBeenCalledWith('unauthorized')
    })
})
