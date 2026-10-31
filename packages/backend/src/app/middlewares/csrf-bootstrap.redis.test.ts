import type { Redis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import {
    cleanupTestRedis,
    createTestRedis,
    hasRedis,
} from '../../test-support/redis-test-client.js'

// Login CSRF against a real Redis: a browser without a cookie first calls
// GET /api/main/init (session_web → csrf_guard → auth_guard), gets 401 with a
// session cookie and a CSRF token, and only then can POST /api/auth/login
// (session_web → csrf_guard) get past the guard. A missing cookie does not mean a
// missing session: session_web creates an anonymous one with its own token, held
// in a signed cookie and written to Redis only when it stores data (feat-057).

const { PREFIX, ORIGIN } = vi.hoisted(() => {
    process.env['APP_KEY'] ??= 'k'.repeat(16) + '3f9a1c7e5b2d4f60'
    process.env['CSRF_ENFORCE'] = 'true'
    process.env['CSRF_STRICT_ORIGIN'] = 'true'
    process.env['CSRF_ALLOWED_ORIGINS'] = 'https://app.test'
    return { PREFIX: `test:${crypto.randomUUID()}:`, ORIGIN: 'https://app.test' }
})

const silent = {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    child: (): unknown => silent,
}
vi.mock('#logger', () => ({ default: silent }))
vi.mock('#vendor/utils/logger.js', () => ({ default: silent }))
vi.mock('#config/redis.js', async (importActual) => {
    const actual = await importActual<{ default: object }>()
    return { default: { ...actual.default, keyPrefix: PREFIX } }
})
vi.mock('#database/redis.js', async () => {
    const { Redis: Client } = await import('ioredis')
    const { mainRedisOptions } = await import('#database/redis-main-options.js')
    const { createRedisHealth, createWithRedis } = await import('#database/redis-health.js')
    const { host: _host, port: _port, ...contract } = mainRedisOptions
    const client = new Client(process.env['REDIS_TEST_URL'] ?? 'redis://127.0.0.1:6379', {
        ...contract,
        keyPrefix: PREFIX,
        lazyConnect: true,
    })
    const redisHealth = createRedisHealth(client, {
        logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
    })
    return {
        default: client,
        redisHealth,
        withRedis: createWithRedis(client, redisHealth),
    }
})

const { default: client, redisHealth } = (await import('#database/redis.js')) as unknown as {
    default: Redis
    redisHealth: { stop(): void }
}
const { default: sessionConfig } = await import('#config/session.js')
const { default: executeMiddlewares } =
    await import('#vendor/utils/middlewares/core/execute-httpMiddlewares.js')
const { default: createContext } = await import('#vendor/utils/context/http-context.js')
const { createResponseData } = await import('#vendor/utils/network/response-data.js')
const { createAnonSessionToken } = await import('#vendor/utils/session/token-handler.js')
const { sessionHandler } = await import('#vendor/utils/session/session-handler.js')

const admin = createTestRedis(PREFIX)

interface RequestInput {
    method: 'get' | 'post'
    middlewares: string[]
    headers?: [string, string][]
    cookie?: string | undefined
}

const request = async ({ method, middlewares, headers = [], cookie }: RequestInput) => {
    const responseData = createResponseData()
    const context = createContext(
        {
            method,
            ip: '127.0.0.1',
            params: {},
            payload: {},
            query: null,
            headers: new Map(headers),
            contentType: 'application/json',
            cookies: new Map(cookie === undefined ? [] : [[sessionConfig.cookieName, cookie]]),
            isJson: true,
            files: null,
            hasFile: () => false,
        },
        responseData,
    )
    const passed = await executeMiddlewares(middlewares, context)
    return {
        context,
        passed,
        status: responseData.status,
        payload: responseData.payload as Record<string, unknown> | null,
        cookie: responseData.cookies.get(sessionConfig.cookieName)?.value,
    }
}

const init = () =>
    request({ method: 'get', middlewares: ['session_web', 'csrf_guard', 'auth_guard'] })

const login = (headers: [string, string][], cookie?: string) =>
    request({ method: 'post', middlewares: ['session_web', 'csrf_guard'], headers, cookie })

beforeAll(async () => {
    if (!hasRedis) return
    await admin.connect()
    await client.connect()
})
afterAll(async () => {
    if (!hasRedis) return
    await cleanupTestRedis(admin)
    redisHealth.stop()
    client.disconnect(false)
    await admin.quit()
})

describe.skipIf(!hasRedis)('login CSRF bootstrap', () => {
    it('init without a cookie answers 401 with a session cookie and a CSRF token', async () => {
        const response = await init()

        expect(response.passed).toBe(false)
        expect(response.status).toBe(401)
        expect(response.cookie).toEqual(expect.any(String))
        expect(response.payload?.['csrfToken']).toMatch(/^[A-Za-z0-9_-]{43}$/)
    })

    it('login with the bootstrap cookie and token passes the guard', async () => {
        const bootstrap = await init()
        const token = String(bootstrap.payload?.['csrfToken'])

        const response = await login(
            [
                ['origin', ORIGIN],
                ['sec-fetch-site', 'same-origin'],
                ['x-csrf-token', token],
            ],
            bootstrap.cookie,
        )

        expect(response.passed).toBe(true)
    })

    it('rejects login without a cookie and token even from the own origin', async () => {
        const response = await login([['origin', ORIGIN]])

        expect(response.passed).toBe(false)
        expect(response.status).toBe(403)
        expect(response.payload).toMatchObject({ code: 'csrf_invalid', reason: 'token_mismatch' })
        // The 403 still carries the token of the session it just created.
        expect(response.payload?.['csrfToken']).toMatch(/^[A-Za-z0-9_-]{43}$/)
    })

    it('rejects login from a foreign origin even with a valid cookie and token', async () => {
        const bootstrap = await init()

        const response = await login(
            [
                ['origin', 'https://evil.example'],
                ['x-csrf-token', String(bootstrap.payload?.['csrfToken'])],
            ],
            bootstrap.cookie,
        )

        expect(response.status).toBe(403)
        expect(response.payload).toMatchObject({ reason: 'origin_mismatch' })
    })

    it('rejects a cross-site login before looking at the token', async () => {
        const bootstrap = await init()

        const response = await login(
            [
                ['origin', ORIGIN],
                ['sec-fetch-site', 'cross-site'],
                ['x-csrf-token', String(bootstrap.payload?.['csrfToken'])],
            ],
            bootstrap.cookie,
        )

        expect(response.status).toBe(403)
        expect(response.payload).toMatchObject({ reason: 'fetch_site_cross_site' })
    })

    it('rejects a login without Origin and Referer', async () => {
        const bootstrap = await init()

        const response = await login(
            [['x-csrf-token', String(bootstrap.payload?.['csrfToken'])]],
            bootstrap.cookie,
        )

        expect(response.status).toBe(403)
        expect(response.payload).toMatchObject({ reason: 'origin_mismatch' })
    })
})

/** A mutation through session_web → csrf_guard with the given cookie and token. */
const mutate = (cookie: string | undefined, token: string) =>
    login(
        [
            ['origin', ORIGIN],
            ['x-csrf-token', token],
        ],
        cookie,
    )

describe.skipIf(!hasRedis)('session rotation on login', () => {
    it('an anonymous cookie never opens the session of the user who logged in with it', async () => {
        const bootstrap = await init()
        const anonToken = String(bootstrap.payload?.['csrfToken'])

        const signIn = await mutate(bootstrap.cookie, anonToken)
        expect(signIn.passed).toBe(true)
        await signIn.context.auth.login('42', 'rotationUserToken01')
        const userToken = String(signIn.context.session.sessionInfo?.data.csrfToken)
        const userCookie = signIn.context.responseData.cookies.get(sessionConfig.cookieName)?.value

        expect(userToken).not.toBe(anonToken)
        expect(userCookie).not.toBe(bootstrap.cookie)

        // A cookie-held anonymous session cannot be revoked: until its TTL the old pair
        // still passes the CSRF check, but only as an anonymous session.
        const replay = await mutate(bootstrap.cookie, anonToken)
        expect(replay.context.auth.getUserId()).toBeNull()
        // The anonymous token does not sign requests of the user's session.
        const crossed = await mutate(userCookie, anonToken)
        expect(crossed.status).toBe(403)
        expect(crossed.payload).toMatchObject({ reason: 'token_mismatch' })

        // The new cookie and token work.
        const next = await mutate(userCookie, userToken)
        expect(next.passed).toBe(true)
        expect(next.context.auth.getUserId()).toBe('42')
    })

    it('renewing a signed-in session (password change) replaces ID and token', async () => {
        const bootstrap = await init()
        const signIn = await mutate(bootstrap.cookie, String(bootstrap.payload?.['csrfToken']))
        await signIn.context.auth.login('43', 'renewUserToken0001')
        const firstCookie = signIn.context.responseData.cookies.get(sessionConfig.cookieName)?.value
        const firstToken = String(signIn.context.session.sessionInfo?.data.csrfToken)
        const firstId = String(signIn.context.session.sessionInfo?.id)

        // What authService.renewSession does after a password change.
        const change = await mutate(firstCookie, firstToken)
        expect(change.passed).toBe(true)
        await change.context.auth.login('43', 'renewUserToken0001')
        const renewedCookie = change.context.responseData.cookies.get(
            sessionConfig.cookieName,
        )?.value
        const renewedToken = String(change.context.session.sessionInfo?.data.csrfToken)

        expect(change.context.session.sessionInfo?.id).not.toBe(firstId)
        expect(renewedToken).not.toBe(firstToken)
        expect(await admin.exists(`session:renewUserToken0001:${firstId}`)).toBe(0)

        expect((await mutate(renewedCookie, renewedToken)).passed).toBe(true)
        const stale = await mutate(firstCookie, firstToken)
        expect(stale.status).toBe(403)
        expect(stale.payload).toMatchObject({ reason: 'token_mismatch' })
    })

    it('session helpers called after login address the new session', async () => {
        const bootstrap = await init()
        const signIn = await mutate(bootstrap.cookie, String(bootstrap.payload?.['csrfToken']))
        await signIn.context.auth.login('44', 'helperUserToken001')

        const updated = await signIn.context.session.updateSessionData({ marker: 'after-login' })

        expect(updated?.id).toBe(signIn.context.session.sessionInfo?.id)
        expect(updated?.data['marker']).toBe('after-login')
    })
})

describe.skipIf(!hasRedis)('session cookie of a slow response', () => {
    const signIn = async (userToken: string) => {
        const bootstrap = await init()
        const response = await mutate(bootstrap.cookie, String(bootstrap.payload?.['csrfToken']))
        await response.context.auth.login('45', userToken)
        return {
            cookie: response.context.responseData.cookies.get(sessionConfig.cookieName)?.value,
            token: String(response.context.session.sessionInfo?.data.csrfToken),
            id: String(response.context.session.sessionInfo?.id),
        }
    }

    it('an unchanged session gets no Set-Cookie until the refresh is due', async () => {
        const s1 = await signIn('slowCookieToken0001')

        const next = await mutate(s1.cookie, s1.token)

        expect(next.passed).toBe(true)
        expect(next.cookie).toBeUndefined()
    })

    it('a slow request does not restore the cookie of a session replaced meanwhile', async () => {
        const s1 = await signIn('slowCookieToken0002')
        // Make the cookie refresh due, so the slow request re-sends the S1 cookie.
        await admin.del(`session_cookie_refresh:${s1.id}`)

        // R1 starts with S1 (its middleware chain prepares Set-Cookie: S1) ...
        const slow = await mutate(s1.cookie, s1.token)
        expect(slow.cookie).toEqual(expect.any(String))
        // ... a password change renews the session meanwhile (S1 deleted, S2 issued) ...
        const change = await mutate(s1.cookie, s1.token)
        await change.context.auth.login('45', 'slowCookieToken0002')
        // ... and R1 answers after it.
        await slow.context.session.beforeSend?.()

        expect(slow.context.responseData.cookies.has(sessionConfig.cookieName)).toBe(false)
    })

    it('a request that swapped the session itself keeps its cookie', async () => {
        const bootstrap = await init()
        const response = await mutate(bootstrap.cookie, String(bootstrap.payload?.['csrfToken']))
        await response.context.auth.login('46', 'slowCookieToken0003')

        await response.context.session.beforeSend?.()

        expect(response.context.responseData.cookies.has(sessionConfig.cookieName)).toBe(true)
    })

    it('a cookie refresh never rewrites the session record', async () => {
        const s1 = await signIn('slowCookieToken0004')
        const key = `session:slowCookieToken0004:${s1.id}`
        await admin.del(`session_cookie_refresh:${s1.id}`)
        const before = await admin.get(key)

        const refreshing = await mutate(s1.cookie, s1.token)

        expect(refreshing.cookie).toEqual(expect.any(String)) // the refresh did happen
        expect(await admin.get(key)).toBe(before) // ...without a write to the session
        // A second request within the hour does not refresh again.
        expect((await mutate(s1.cookie, s1.token)).cookie).toBeUndefined()
    })

    it('a refresh for a session deleted meanwhile does not bring it back', async () => {
        const s1 = await signIn('slowCookieToken0005')
        await admin.del(`session_cookie_refresh:${s1.id}`)
        await admin.del(`session:slowCookieToken0005:${s1.id}`)

        const response = await mutate(s1.cookie, s1.token)

        expect(await admin.exists(`session:slowCookieToken0005:${s1.id}`)).toBe(0)
        expect(response.status).toBe(403) // the old token belongs to no session
    })
})

/** Keys this test file owns in Redis (all of them carry PREFIX). */
const ownKeys = async (): Promise<string[]> => await admin.keys('*')

const anonCookie = (
    issuedAt: number,
    csrfToken = 'a'.repeat(43),
    sessionId = crypto.randomUUID(),
) => createAnonSessionToken({ sessionId, csrfToken, issuedAt })

describe.skipIf(!hasRedis)('anonymous session in a signed cookie (feat-057)', () => {
    const nowSec = (): number => Math.floor(Date.now() / 1000)

    it('init without a cookie writes nothing to Redis', async () => {
        const before = await ownKeys()

        const response = await init()

        expect(response.status).toBe(401)
        expect(response.payload?.['csrfToken']).toMatch(/^[A-Za-z0-9_-]{43}$/)
        expect(await ownKeys()).toEqual(before)
    })

    it('a mutation with the anonymous cookie and token writes nothing to Redis either', async () => {
        const bootstrap = await init()
        const before = await ownKeys()

        const response = await mutate(bootstrap.cookie, String(bootstrap.payload?.['csrfToken']))

        expect(response.passed).toBe(true)
        expect(await ownKeys()).toEqual(before)
    })

    it('a tampered anonymous cookie opens a new session, its token is rejected', async () => {
        const bootstrap = await init()
        const token = String(bootstrap.payload?.['csrfToken'])
        const decoded = Buffer.from(String(bootstrap.cookie), 'base64').toString('utf8')
        const forged = Buffer.from(decoded.replace(token, 'b'.repeat(43))).toString('base64')

        const response = await mutate(forged, 'b'.repeat(43))

        expect(response.status).toBe(403)
        expect(response.payload).toMatchObject({ reason: 'token_mismatch' })
        expect(response.payload?.['csrfToken']).not.toBe('b'.repeat(43))
    })

    it('an anonymous cookie older than SESSION_ANON_TTL is not accepted', async () => {
        const csrfToken = 'c'.repeat(43)
        const expired = anonCookie(nowSec() - sessionConfig.anonAge - 1, csrfToken)

        const response = await mutate(expired, csrfToken)

        expect(response.status).toBe(403)
        expect(response.payload?.['csrfToken']).not.toBe(csrfToken)
    })

    it('a fresh anonymous cookie is not sent again', async () => {
        const csrfToken = 'd'.repeat(43)

        const response = await mutate(anonCookie(nowSec() - 60, csrfToken), csrfToken)

        expect(response.passed).toBe(true)
        expect(response.cookie).toBeUndefined()
    })

    it('an anonymous cookie past the refresh interval is re-issued with the same token', async () => {
        const csrfToken = 'e'.repeat(43)
        const sessionId = crypto.randomUUID()

        const response = await mutate(
            anonCookie(nowSec() - 16 * 60, csrfToken, sessionId),
            csrfToken,
        )

        expect(response.passed).toBe(true)
        expect(response.cookie).toEqual(expect.any(String))
        const next = await mutate(response.cookie, csrfToken)
        expect(next.passed).toBe(true)
        expect(next.context.session.sessionInfo?.id).toBe(sessionId)
    })

    it('a cookie signed for a user session is not read as an anonymous one', async () => {
        const bootstrap = await init()
        const signIn = await mutate(bootstrap.cookie, String(bootstrap.payload?.['csrfToken']))
        await signIn.context.auth.login('47', 'formatUserToken0001')
        const userCookie = String(
            signIn.context.responseData.cookies.get(sessionConfig.cookieName)?.value,
        )
        const decoded = Buffer.from(userCookie, 'base64').toString('utf8')
        // The user cookie's signature over `anon-v1.<id>.<token>.<time>` data does not verify.
        const [, id, sig] = decoded.split('.')
        const spliced = Buffer.from(
            `anon-v1.${String(id)}.${'f'.repeat(43)}.${String(nowSec())}.${String(sig)}`,
        ).toString('base64')

        const response = await mutate(spliced, 'f'.repeat(43))

        expect(response.status).toBe(403)
        expect(response.context.auth.getUserId()).toBeNull()
    })

    it('storing data moves the anonymous session to Redis with the anonymous TTL', async () => {
        const bootstrap = await init()
        const token = String(bootstrap.payload?.['csrfToken'])
        const response = await mutate(bootstrap.cookie, token)
        const id = String(response.context.session.sessionInfo?.id)

        await response.context.session.updateSessionData({ oauthState: 'state-1' })

        const key = `session:anon_session:${id}`
        const ttl = await admin.ttl(key)
        expect(ttl).toBeGreaterThan(sessionConfig.anonAge - 10)
        expect(ttl).toBeLessThanOrEqual(sessionConfig.anonAge)
        const stored = response.context.responseData.cookies.get(sessionConfig.cookieName)?.value
        expect(stored).toEqual(expect.any(String))

        // The next request reads the stored data with the same CSRF token.
        const next = await mutate(stored, token)
        expect(next.passed).toBe(true)
        expect(next.context.session.sessionInfo?.data['oauthState']).toBe('state-1')
    })

    it('logout hands out a cookie-held anonymous session', async () => {
        const bootstrap = await init()
        const signIn = await mutate(bootstrap.cookie, String(bootstrap.payload?.['csrfToken']))
        await signIn.context.auth.login('48', 'logoutUserToken0001')
        const cookie = signIn.context.responseData.cookies.get(sessionConfig.cookieName)?.value
        const token = String(signIn.context.session.sessionInfo?.data.csrfToken)
        const out = await mutate(cookie, token)
        const before = await ownKeys()

        await out.context.auth.logout()

        expect((await ownKeys()).length).toBe(before.length - 1) // only the user session went away
        const anonToken = String(out.context.session.sessionInfo?.data.csrfToken)
        const anon = out.context.responseData.cookies.get(sessionConfig.cookieName)?.value
        const next = await mutate(anon, anonToken)
        expect(next.passed).toBe(true)
        expect(next.context.auth.getUserId()).toBeNull()
    })
})

describe.skipIf(!hasRedis)('stale anonymous cookie refresh (feat-057 review)', () => {
    const nowSec = (): number => Math.floor(Date.now() / 1000)
    /** An anonymous cookie past the refresh interval: every request re-issues it. */
    const aged = (csrfToken: string, sessionId = crypto.randomUUID()) => ({
        cookie: anonCookie(nowSec() - 16 * 60, csrfToken, sessionId),
        csrfToken,
        sessionId,
    })

    it('a slow response does not overwrite the cookie of a login made meanwhile', async () => {
        const anon = aged('g'.repeat(43))
        // R1 starts with the aged cookie: its chain prepares a re-issued anonymous cookie ...
        const slow = await mutate(anon.cookie, anon.csrfToken)
        expect(slow.cookie).toEqual(expect.any(String))
        // ... R2 logs in with the same cookie ...
        const signIn = await mutate(anon.cookie, anon.csrfToken)
        await signIn.context.auth.login('49', 'raceUserToken00001')
        // ... and R1 answers after it.
        await slow.context.session.beforeSend?.()

        expect(slow.context.responseData.cookies.has(sessionConfig.cookieName)).toBe(false)
    })

    it('a slow response does not overwrite the cookie of a session moved to Redis meanwhile', async () => {
        const anon = aged('h'.repeat(43))
        const slow = await mutate(anon.cookie, anon.csrfToken)
        const oauth = await mutate(anon.cookie, anon.csrfToken)
        await oauth.context.session.updateSessionData({ oauthState: 'state-2' })

        await slow.context.session.beforeSend?.()

        expect(slow.context.responseData.cookies.has(sessionConfig.cookieName)).toBe(false)
        // The stored session and its data stay reachable with R2's cookie.
        const stored = oauth.context.responseData.cookies.get(sessionConfig.cookieName)?.value
        const next = await mutate(stored, anon.csrfToken)
        expect(next.context.session.sessionInfo?.data['oauthState']).toBe('state-2')
    })

    it('a slow response does not overwrite a login made after a move to Redis', async () => {
        const anon = aged('l'.repeat(43))
        // R1 starts with the aged cookie-held session ...
        const slow = await mutate(anon.cookie, anon.csrfToken)
        // ... R2 moves it to Redis (OAuth state) ...
        const oauth = await mutate(anon.cookie, anon.csrfToken)
        await oauth.context.session.updateSessionData({ oauthState: 'state-4' })
        const stored = oauth.context.responseData.cookies.get(sessionConfig.cookieName)?.value
        // ... R3 logs in from the stored session, which deletes its record ...
        const signIn = await mutate(stored, anon.csrfToken)
        await signIn.context.auth.login('50', 'raceUserToken00002')
        expect(await admin.exists(`session:anon_session:${anon.sessionId}`)).toBe(0)
        // ... and R1 answers last.
        await slow.context.session.beforeSend?.()

        expect(slow.context.responseData.cookies.has(sessionConfig.cookieName)).toBe(false)
    })

    it('a late response that moved the session to Redis does not undo a login made meanwhile', async () => {
        // A fresh cookie: the race does not depend on the refresh interval.
        const csrfToken = 'm'.repeat(43)
        const sessionId = crypto.randomUUID()
        const cookie = anonCookie(nowSec() - 60, csrfToken, sessionId)
        // R2 moves the session to Redis (its response still to come) ...
        const oauth = await mutate(cookie, csrfToken)
        await oauth.context.session.updateSessionData({ oauthState: 'state-5' })
        // ... R3 logs in with the same original cookie ...
        const signIn = await mutate(cookie, csrfToken)
        await signIn.context.auth.login('51', 'raceUserToken00003')
        // ... and R2 answers last.
        await oauth.context.session.beforeSend?.()

        expect(oauth.context.responseData.cookies.has(sessionConfig.cookieName)).toBe(false)
        // The login also took the stored anonymous record with it.
        expect(await admin.exists(`session:anon_session:${sessionId}`)).toBe(0)
    })

    it('an unchallenged refresh keeps its cookie', async () => {
        const anon = aged('i'.repeat(43))
        const response = await mutate(anon.cookie, anon.csrfToken)

        await response.context.session.beforeSend?.()

        expect(response.context.responseData.cookies.has(sessionConfig.cookieName)).toBe(true)
    })

    it('a request that moved its own session to Redis keeps its cookie', async () => {
        const anon = aged('j'.repeat(43))
        const response = await mutate(anon.cookie, anon.csrfToken)
        await response.context.session.updateSessionData({ oauthState: 'state-3' })

        await response.context.session.beforeSend?.()

        expect(response.context.responseData.cookies.has(sessionConfig.cookieName)).toBe(true)
    })

    it('a fresh anonymous cookie under the legacy name is re-issued under the active one', async () => {
        const csrfToken = 'k'.repeat(43)
        const responseData = createResponseData()
        const context = createContext(
            {
                method: 'get',
                ip: '127.0.0.1',
                params: {},
                payload: {},
                query: null,
                headers: new Map(),
                contentType: 'application/json',
                cookies: new Map(),
                isJson: true,
                files: null,
                hasFile: () => false,
            },
            responseData,
        )

        // What session_web does for a cookie found only under the legacy name.
        await sessionHandler(context, anonCookie(nowSec() - 60, csrfToken), undefined, true)

        expect(responseData.cookies.get(sessionConfig.cookieName)?.value).toEqual(
            expect.any(String),
        )
        expect(context.session.sessionInfo?.data.csrfToken).toBe(csrfToken)
    })
})
