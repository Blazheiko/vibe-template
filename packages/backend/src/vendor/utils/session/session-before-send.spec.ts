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
})
