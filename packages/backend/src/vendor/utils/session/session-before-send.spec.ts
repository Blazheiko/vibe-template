import { beforeEach, describe, expect, it, vi } from 'vitest'

// beforeSend runs after the handler: a Redis failure there must not replace the
// handler's result, only hold back the cookie it could not confirm.

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
    return value as { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> }
})

vi.hoisted(() => {
    process.env['APP_KEY'] ??= 'k'.repeat(16) + '3f9a1c7e5b2d4f60'
})
vi.mock('#vendor/utils/session/redis-session-storage.js', () => storage)
vi.mock('#vendor/utils/logger.js', () => ({ default: logger }))
vi.mock('#logger', () => ({ default: logger }))

const { sessionHandler } = await import('./session-handler.js')
const { registerSessionTokenChecker } = await import('./session-token-check.js')

// The sessionToken check has its own spec (session-revocation.spec.ts): here every
// session is current.
registerSessionTokenChecker(() => Promise.resolve('ok'))
const { createSignedToken, createAnonSessionToken } = await import('./token-handler.js')
const { createResponseData } = await import('#vendor/utils/network/response-data.js')
const { default: createContext } = await import('#vendor/utils/context/http-context.js')
const { default: sessionConfig } = await import('#config/session.js')

class RedisDown extends Error {}

const USER_TOKEN = 'beforeSendToken0001'

const run = async () => {
    const responseData = createResponseData()
    const context = createContext(
        { method: 'post', headers: new Map(), cookies: new Map() } as never,
        responseData,
    )
    await sessionHandler(context, createSignedToken(`${USER_TOKEN}.s1`), undefined)
    return context
}

describe('session beforeSend', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        storage.getSession.mockResolvedValue({
            id: 's1',
            data: { userId: '7', userToken: USER_TOKEN, csrfToken: 'c'.repeat(43) },
            createdAt: new Date().toISOString(),
        })
        storage.claimCookieRefresh.mockResolvedValue(true)
    })

    it('a refresh claims the marker and does not write the session', async () => {
        const context = await run()

        expect(storage.claimCookieRefresh).toHaveBeenCalledWith('s1', 3600)
        expect(storage.updateSessionData).not.toHaveBeenCalled()
        expect(storage.saveSession).not.toHaveBeenCalled()
        expect(context.responseData.cookies.has(sessionConfig.cookieName)).toBe(true)
    })

    it('keeps the cookie while the session exists', async () => {
        storage.sessionExists.mockResolvedValue(true)
        const context = await run()

        await context.session.beforeSend?.()

        expect(context.responseData.cookies.has(sessionConfig.cookieName)).toBe(true)
    })

    it('drops the cookie of a session deleted meanwhile', async () => {
        storage.sessionExists.mockResolvedValue(false)
        const context = await run()

        await context.session.beforeSend?.()

        expect(context.responseData.cookies.has(sessionConfig.cookieName)).toBe(false)
    })

    it('on a Redis failure drops the cookie, logs, and does not throw', async () => {
        storage.sessionExists.mockRejectedValue(new Error('Redis down'))
        const context = await run()

        await expect(context.session.beforeSend?.()).resolves.toBeUndefined()

        expect(context.responseData.cookies.has(sessionConfig.cookieName)).toBe(false)
        expect(logger.warn).toHaveBeenCalledWith(
            expect.anything(),
            'Session cookie refresh skipped: session check failed',
        )
    })

    it('no refresh due: no cookie and no beforeSend', async () => {
        storage.claimCookieRefresh.mockResolvedValue(false)
        const context = await run()

        expect(context.responseData.cookies.has(sessionConfig.cookieName)).toBe(false)
        expect(context.session.beforeSend).toBeUndefined()
    })

    it('a request without a cookie gets a cookie-held session: nothing is stored', async () => {
        const responseData = createResponseData()
        const context = createContext(
            { method: 'get', headers: new Map(), cookies: new Map() } as never,
            responseData,
        )

        await sessionHandler(context, undefined, undefined)

        expect(storage.saveSession).not.toHaveBeenCalled()
        expect(storage.markCookieIssued).not.toHaveBeenCalled()
        expect(context.session.sessionInfo?.data.csrfToken).toEqual(expect.any(String))
        expect(responseData.cookies.has(sessionConfig.cookieName)).toBe(true)
    })

    it('a failed marker write does not fail the login', async () => {
        storage.markCookieIssued.mockRejectedValue(new Error('Redis down'))
        const responseData = createResponseData()
        const context = createContext(
            { method: 'post', headers: new Map(), cookies: new Map() } as never,
            responseData,
        )
        await sessionHandler(context, undefined, undefined)

        await expect(context.auth.login('7', 'markerUserToken001')).resolves.toBe(true)

        expect(storage.saveSession).toHaveBeenCalledOnce()
        expect(context.auth.getUserId()).toBe('7')
        expect(responseData.cookies.has(sessionConfig.cookieName)).toBe(true)
        expect(logger.warn).toHaveBeenCalledWith(
            expect.anything(),
            'Cookie refresh marker not set for a new session',
        )
    })

    it('a failed check holds back a re-issued anonymous cookie', async () => {
        storage.anonSessionSuperseded.mockRejectedValue(new RedisDown())
        const responseData = createResponseData()
        const context = createContext(
            { method: 'get', headers: new Map(), cookies: new Map() } as never,
            responseData,
        )
        const aged = createAnonSessionToken({
            sessionId: 'anon-1',
            csrfToken: 'a'.repeat(43),
            issuedAt: Math.floor(Date.now() / 1000) - 16 * 60,
        })
        await sessionHandler(context, aged, undefined)
        expect(responseData.cookies.has(sessionConfig.cookieName)).toBe(true)

        await expect(context.session.beforeSend?.()).resolves.toBeUndefined()

        expect(responseData.cookies.has(sessionConfig.cookieName)).toBe(false)
        expect(logger.warn).toHaveBeenCalledWith(
            expect.anything(),
            'Anonymous cookie refresh skipped: session check failed',
        )
    })

    it('a failed check holds back the cookie of a move to Redis', async () => {
        storage.anonSessionSignedIn.mockRejectedValue(new RedisDown())
        const responseData = createResponseData()
        const context = createContext(
            { method: 'post', headers: new Map(), cookies: new Map() } as never,
            responseData,
        )
        await sessionHandler(context, undefined, undefined)
        await context.session.updateSessionData({ oauthState: 's' })
        expect(storage.saveSession).toHaveBeenCalledOnce()

        await expect(context.session.beforeSend?.()).resolves.toBeUndefined()

        expect(responseData.cookies.has(sessionConfig.cookieName)).toBe(false)
        expect(logger.warn).toHaveBeenCalledWith(
            expect.anything(),
            'Stored anonymous cookie held back: session check failed',
        )
    })
})

// feat-088: a storage failure in auth.login / logout / logoutAll propagates without a
// log record here; the service turns it into an AppError and the controller logs it
// once (reportAppError), so one failure is one error record, not two.
// feat-094: a request that replaces its own session keeps the cookie it set. Both
// guards were untested before the RequestSession refactor.
describe('session beforeSend after the request replaced its own session', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        storage.getSession.mockResolvedValue({
            id: 's1',
            data: { userId: '7', userToken: USER_TOKEN, csrfToken: 'c'.repeat(43) },
            createdAt: new Date().toISOString(),
        })
    })

    it('keeps the anonymous cookie of a logout over a refreshed signed-in cookie', async () => {
        storage.claimCookieRefresh.mockResolvedValue(true)
        const context = await run()

        await context.auth.logout()
        const anonymousCookie = context.responseData.cookies.get(sessionConfig.cookieName)
        // The old session is gone now; checking it again must not drop the new cookie.
        storage.sessionExists.mockResolvedValue(false)
        await context.session.beforeSend?.()

        expect(context.responseData.cookies.get(sessionConfig.cookieName)).toBe(anonymousCookie)
        expect(storage.sessionExists).not.toHaveBeenCalled()
    })

    it('keeps the login cookie after the anonymous session was moved to Redis', async () => {
        const responseData = createResponseData()
        const context = createContext(
            { method: 'post', headers: new Map(), cookies: new Map() } as never,
            responseData,
        )
        await sessionHandler(context, undefined, undefined)
        await context.session.updateSessionData({ oauthState: 's' })

        await context.auth.login('7', USER_TOKEN)
        const loginCookie = responseData.cookies.get(sessionConfig.cookieName)
        // The login itself marked the old anonymous session; that must not undo its cookie.
        storage.anonSessionSignedIn.mockResolvedValue(true)
        await context.session.beforeSend?.()

        expect(responseData.cookies.get(sessionConfig.cookieName)).toBe(loginCookie)
        expect(storage.anonSessionSignedIn).not.toHaveBeenCalled()
    })
})

// feat-095 (code review): a cookie naming a session that is no longer in Redis starts a
// new anonymous session; it must live in the anonymous namespace from the first write on.
describe('a cookie of a missing session', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        storage.getSession.mockResolvedValue(null)
        storage.updateSessionData.mockResolvedValue(null)
    })

    it('starts an anonymous session whose later changes address the anonymous namespace', async () => {
        const context = await run()
        expect(context.auth.check()).toBe(false)

        await context.session.updateSessionData({ oauthState: 'first' })
        expect(storage.saveSession).toHaveBeenCalledOnce()

        await context.session.updateSessionData({ oauthState: 'second' })

        expect(storage.updateSessionData).toHaveBeenCalledWith(
            context.session.sessionInfo?.id,
            { oauthState: 'second' },
            'anon_session',
        )
    })
})

describe('session auth methods on a storage failure', () => {
    const loggerError = (logger as unknown as { error: ReturnType<typeof vi.fn> }).error

    beforeEach(() => {
        vi.clearAllMocks()
        storage.getSession.mockResolvedValue({
            id: 's1',
            data: { userId: '7', userToken: USER_TOKEN, csrfToken: 'c'.repeat(43) },
            createdAt: new Date().toISOString(),
        })
        storage.claimCookieRefresh.mockResolvedValue(false)
    })

    it('auth.login rejects and leaves the logging to the caller', async () => {
        const context = await run()
        storage.saveSession.mockRejectedValue(new RedisDown('save failed'))

        await expect(context.auth.login('7', USER_TOKEN)).rejects.toThrow('save failed')
        expect(loggerError).not.toHaveBeenCalled()
    })

    it('auth.logout rejects and leaves the logging to the caller', async () => {
        const context = await run()
        storage.destroySession.mockRejectedValue(new RedisDown('destroy failed'))

        await expect(context.auth.logout()).rejects.toThrow('destroy failed')
        expect(loggerError).not.toHaveBeenCalled()
    })

    it('auth.logoutAll rejects and leaves the logging to the caller', async () => {
        const context = await run()
        storage.destroyAllSessions.mockRejectedValue(new RedisDown('destroy all failed'))

        await expect(context.auth.logoutAll()).rejects.toThrow('destroy all failed')
        expect(loggerError).not.toHaveBeenCalled()
    })
})
