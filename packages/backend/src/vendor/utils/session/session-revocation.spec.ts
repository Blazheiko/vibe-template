import { beforeEach, describe, expect, it, vi } from 'vitest'

// ADR 0002: the Redis record of a session only proves it was issued. A rotated
// users.sessionToken revokes it, and a lookup that cannot answer never lets the
// request through on the strength of the record alone.

const storage = vi.hoisted(() => ({
    saveSession: vi.fn(),
    getSession: vi.fn(),
    updateSessionData: vi.fn(),
    changeSessionData: vi.fn(),
    destroySession: vi.fn(),
    destroyAllSessions: vi.fn(),
    claimCookieRefresh: vi.fn(),
    markCookieIssued: vi.fn(),
    sessionExists: vi.fn(),
    markAnonSessionSuperseded: vi.fn(),
    anonSessionSuperseded: vi.fn(),
    anonSessionSignedIn: vi.fn(),
}))
const logger = vi.hoisted(() => {
    const value: Record<string, unknown> = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    }
    value['child'] = () => value
    return value as { warn: ReturnType<typeof vi.fn> }
})

vi.hoisted(() => {
    process.env['APP_KEY'] ??= 'k'.repeat(16) + '3f9a1c7e5b2d4f60'
})
vi.mock('#vendor/utils/session/redis-session-storage.js', () => storage)
vi.mock('#vendor/utils/logger.js', () => ({ default: logger }))
vi.mock('#logger', () => ({ default: logger }))

const { sessionHandler } = await import('./session-handler.js')
const { registerSessionTokenChecker } = await import('./session-token-check.js')
const { createSignedToken, createAnonSessionToken } = await import('./token-handler.js')
const { SessionVerificationUnavailableError } =
    await import('#vendor/utils/network/errors/session-verification-unavailable-error.js')
const { createResponseData } = await import('#vendor/utils/network/response-data.js')
const { default: createContext } = await import('#vendor/utils/context/http-context.js')
const { default: sessionConfig } = await import('#config/session.js')

const checker = vi.fn()
registerSessionTokenChecker(checker)

const USER_TOKEN = 'revocationToken0001'
const CSRF = 'c'.repeat(43)

const signedInSession = () => ({
    id: 's1',
    data: { userId: '7', userToken: USER_TOKEN, csrfToken: CSRF },
    createdAt: new Date().toISOString(),
})

const request = async (cookie: string) => {
    const responseData = createResponseData()
    const context = createContext(
        { method: 'get', headers: new Map(), cookies: new Map() } as never,
        responseData,
    )
    await sessionHandler(context, cookie, undefined)
    return { context, responseData }
}

const signedInCookie = () => createSignedToken(`${USER_TOKEN}.s1`)

beforeEach(() => {
    vi.clearAllMocks()
    storage.getSession.mockResolvedValue(signedInSession())
    storage.claimCookieRefresh.mockResolvedValue(false)
    checker.mockResolvedValue('ok')
})

describe('session revocation by sessionToken', () => {
    it('keeps a session whose token is still current', async () => {
        const { context } = await request(signedInCookie())

        expect(checker).toHaveBeenCalledWith('7', USER_TOKEN)
        expect(context.auth.check()).toBe(true)
        expect(context.auth.getUserId()).toBe('7')
    })

    it('treats a session with a rotated token as anonymous even though its record exists', async () => {
        checker.mockResolvedValue('mismatch')

        const { context, responseData } = await request(signedInCookie())

        expect(context.auth.check()).toBe(false)
        expect(context.auth.getUserId()).toBeNull()
        // A fresh anonymous session and CSRF token, so the client can sign in again.
        expect(context.session.sessionInfo?.id).not.toBe('s1')
        expect(context.session.sessionInfo?.data.userId).toBeUndefined()
        expect(responseData.cookies.has(sessionConfig.cookieName)).toBe(true)
        expect(storage.destroySession).toHaveBeenCalledWith('s1', USER_TOKEN)
    })

    it('does not fail the request when deleting the revoked record fails', async () => {
        checker.mockResolvedValue('mismatch')
        storage.destroySession.mockRejectedValue(new Error('redis down'))

        const { context } = await request(signedInCookie())

        expect(context.auth.check()).toBe(false)
        expect(logger.warn).toHaveBeenCalled()
    })

    it('refuses the request when the sessionToken lookup is unavailable', async () => {
        checker.mockResolvedValue('unavailable')

        await expect(request(signedInCookie())).rejects.toBeInstanceOf(
            SessionVerificationUnavailableError,
        )
        // Not revoked, not served: the record is left alone.
        expect(storage.destroySession).not.toHaveBeenCalled()
    })

    it('does not look anything up for an anonymous cookie', async () => {
        const anon = createAnonSessionToken({
            sessionId: 'anon-1',
            csrfToken: CSRF,
            issuedAt: Math.floor(Date.now() / 1000),
        })

        const { context } = await request(anon)

        expect(checker).not.toHaveBeenCalled()
        expect(context.auth.check()).toBe(false)
    })

    it('does not look anything up when there is no session record', async () => {
        storage.getSession.mockResolvedValue(null)

        const { context } = await request(signedInCookie())

        expect(checker).not.toHaveBeenCalled()
        expect(context.auth.check()).toBe(false)
    })
})
