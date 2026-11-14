import type { Redis } from 'ioredis'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import {
    cleanupTestRedis,
    createTestRedis,
    hasRedis,
} from '../../../test-support/redis-test-client.js'

// feat-111 (R09) on a real Redis with the production main-client contract:
// - a session update writes only over the record it read (one Lua compare-and-set): a record a
//   logout deleted meanwhile is not brought back, and concurrent updates both land;
// - RequestSession.restore treats a record that vanished during its CSRF repair as no session;
// - the OAuth redirect stops with 401 when its session vanished, instead of a state never stored;
// - a stored session older than SESSION_MAX_AGE_DAYS is ended at restore, and (feat-119, F1) for
//   every WebSocket message too;
// - (feat-119, F2) an OAuth callback whose session a logout deleted after it was read signs nobody
//   in.
// The users table is a Map here, as in logout-all.redis.test.ts.

const { PREFIX } = vi.hoisted(() => {
    process.env['APP_KEY'] ??= 'k'.repeat(16) + '3f9a1c7e5b2d4f60'
    process.env['CSRF_ENFORCE'] = 'true'
    process.env['CSRF_ALLOWED_ORIGINS'] = 'https://app.test'
    return { PREFIX: `test:${crypto.randomUUID()}:` }
})

// child() returns the same mock: request loggers are children of children
// (context, then session_web binds userId).
const silent = {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    child: (): unknown => silent,
}
vi.mock('#logger', () => ({ default: silent }))
vi.mock('#vendor/utils/logger.js', () => ({ default: silent }))

const security = vi.hoisted(() => vi.fn())
const oauthUrl = vi.hoisted(() => vi.fn())
const oauthCallback = vi.hoisted(() => vi.fn())
vi.mock('#app/services/auth/oauth-service.js', async (importActual) => {
    const actual = await importActual<{ oauthService: object }>()
    return {
        ...actual,
        oauthService: {
            ...actual.oauthService,
            getAuthorizationUrl: oauthUrl,
            handleCallback: oauthCallback,
        },
    }
})
vi.mock('#app/services/notifications/user-notification-service.js', () => ({
    userNotificationService: { security, supportReply: vi.fn() },
}))

// users.sessionToken by user id: what logout-all rotates and the guard compares.
const fakeUsers = vi.hoisted(() => ({ tokens: new Map<string, string>() }))
vi.mock('#app/repositories/index.js', async (importActual) => {
    const actual = await importActual<Record<string, unknown>>()
    return {
        ...actual,
        // feat-109: logout-all rotates the token and retires the reset links in one
        // transaction; there is no database in this suite.
        withTransaction: <T>(work: (tx: unknown) => Promise<T>): Promise<T> => work({}),
        passwordResetRepository: { invalidatePendingByUserId: () => Promise.resolve(0) },
        userRepository: {
            findSessionToken: (id: bigint) => Promise.resolve(fakeUsers.tokens.get(String(id))),
            update: (id: bigint, data: { sessionToken?: string }) => {
                if (data.sessionToken !== undefined) {
                    fakeUsers.tokens.set(String(id), data.sessionToken)
                }
                return Promise.resolve({ id })
            },
            // feat-096: logout-all rotates only while the presented token is current.
            updateIfSessionToken: (
                id: bigint,
                expected: string,
                data: { sessionToken?: string },
            ) => {
                if (fakeUsers.tokens.get(String(id)) !== expected) return Promise.resolve(undefined)
                if (data.sessionToken !== undefined) {
                    fakeUsers.tokens.set(String(id), data.sessionToken)
                }
                // A user row has a phone column; these users have none (feat-121 reads it).
                return Promise.resolve({ id, phone: null })
            },
        },
    }
})
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
const storage = await import('./redis-session-storage.js')
const { createSignedToken } = await import('./token-handler.js')
const { default: sessionConfig } = await import('#config/session.js')
const { default: executeMiddlewares } =
    await import('#vendor/utils/middlewares/core/execute-httpMiddlewares.js')
const { default: createContext } = await import('#vendor/utils/context/http-context.js')
const { createResponseData } = await import('#vendor/utils/network/response-data.js')
const { registerSessionTokenChecker } = await import('./session-token-check.js')
const { checkSessionToken } = await import('#app/services/auth/session-token-check.js')

registerSessionTokenChecker(checkSessionToken)

const admin = createTestRedis(PREFIX)
const USER_TOKEN = 'sessionStoreToken001'
const CSRF = 'c'.repeat(43)

const save = (id: string, over: { createdAt?: string; data?: Record<string, unknown> } = {}) =>
    storage.saveSession({
        id,
        data: { userId: '42', userToken: USER_TOKEN, csrfToken: CSRF, ...over.data },
        createdAt: over.createdAt ?? new Date().toISOString(),
    })

const recordOf = async (id: string) => {
    const json = await admin.get(`session:${USER_TOKEN}:${id}`)
    return json === null ? null : (JSON.parse(json) as { data: Record<string, unknown> })
}

// Deletes the record right before the next compare-and-set reaches Redis: a logout in another
// tab, between the read and the write of an update.
const deleteBeforeNextWrite = (id: string): void => {
    const original = client.eval.bind(client) as (...args: unknown[]) => Promise<unknown>
    vi.spyOn(client, 'eval').mockImplementationOnce(async (...args: unknown[]) => {
        await admin.del(`session:${USER_TOKEN}:${id}`)
        return original(...args)
    })
}

/** Context of a request with the session cookie and CSRF header. */
const createRequest = (sessionId = 'current') => {
    const cookie = createSignedToken(`${USER_TOKEN}.${sessionId}`)
    const responseData = createResponseData()
    const context = createContext(
        {
            method: 'post',
            ip: '127.0.0.1',
            params: {},
            payload: {},
            query: null,
            headers: new Map([
                ['origin', 'https://app.test'],
                ['x-csrf-token', CSRF],
            ]),
            contentType: 'application/json',
            cookies: new Map([[sessionConfig.cookieName, cookie]]),
            isJson: true,
            files: null,
            hasFile: () => false,
        } as never,
        responseData,
    )
    return { context, responseData }
}

/** Whether a request with this session cookie gets past auth_guard. */
const authenticates = async (sessionId: string): Promise<boolean> => {
    const probe = createRequest(sessionId)
    return executeMiddlewares(['session_web', 'auth_guard'], probe.context)
}

beforeAll(async () => {
    if (!hasRedis) return
    await admin.connect()
    await client.connect()
})
beforeEach(async () => {
    if (!hasRedis) return
    vi.restoreAllMocks()
    security.mockClear()
    fakeUsers.tokens.set('42', USER_TOKEN)
    await cleanupTestRedis(admin)
})
afterAll(async () => {
    if (!hasRedis) return
    await cleanupTestRedis(admin)
    redisHealth.stop()
    client.disconnect(false)
    await admin.quit()
})

describe.skipIf(!hasRedis)('session updates on a real Redis (feat-111)', () => {
    it('does not bring back a record deleted between the read and the write', async () => {
        await save('gone')
        deleteBeforeNextWrite('gone')

        const updated = await storage.updateSessionData('gone', { oauthState: 'x' }, USER_TOKEN)

        expect(updated).toBeNull()
        expect(await recordOf('gone')).toBeNull()
    })

    it('keeps both of two concurrent updates of different fields', async () => {
        await save('both')

        await Promise.all([
            storage.updateSessionData('both', { first: '1' }, USER_TOKEN),
            storage.updateSessionData('both', { second: '2' }, USER_TOKEN),
        ])

        expect((await recordOf('both'))?.data).toMatchObject({ first: '1', second: '2' })
    })

    it('keeps the TTL of a stored session', async () => {
        await save('ttl')
        await storage.updateSessionData('ttl', { x: '1' }, USER_TOKEN)

        expect(await admin.ttl(`session:${USER_TOKEN}:ttl`)).toBeGreaterThan(23 * 3600)
    })
})

describe.skipIf(!hasRedis)('RequestSession with a vanishing or too old record (feat-111)', () => {
    it('a record deleted during the CSRF repair is no session: anonymous, auth refused', async () => {
        await save('repair', { data: { csrfToken: undefined } })
        deleteBeforeNextWrite('repair')
        const request = createRequest('repair')

        const passed = await executeMiddlewares(['session_web', 'auth_guard'], request.context)

        expect(passed).toBe(false)
        expect(request.responseData.status).toBe(401)
        expect(request.responseData.cookies.has(sessionConfig.cookieName)).toBe(true)
        expect(await recordOf('repair')).toBeNull()
    })

    it('the OAuth redirect answers 401 and stores nothing when its session vanished', async () => {
        await save('oauth')
        const { Result } = await import('better-result')
        oauthUrl.mockReturnValue(
            Result.ok({ url: 'https://provider.test/auth', state: 's', codeVerifier: 'v' }),
        )
        const { default: OAuthController } =
            await import('#app/controllers/http/auth/oauth-controller.js')
        const request = createRequest('oauth')
        request.context.httpData.params = { provider: 'google' }
        expect(await executeMiddlewares(['session_web'], request.context)).toBe(true)
        // A logout in another tab, after this request restored the session.
        await admin.del(`session:${USER_TOKEN}:oauth`)

        const payload = await OAuthController.redirect(request.context as never)

        expect(request.responseData.status).toBe(401)
        expect(payload).toMatchObject({ code: 'unauthorized', reason: 'session_revoked' })
        expect(request.responseData.headers.some((h) => h.name === 'Location')).toBe(false)
        expect(await recordOf('oauth')).toBeNull()
    })

    it.each([
        ['exactly the maximum age', 30 * 24 * 3600 * 1000, false],
        ['one second younger than the maximum', 30 * 24 * 3600 * 1000 - 1000, true],
    ])('a session of %s (%i ms old): authenticated = %s', async (_label, ageMs, authenticated) => {
        const id = `age-${String(ageMs)}`
        await save(id, { createdAt: new Date(Date.now() - ageMs).toISOString() })

        expect(await authenticates(id)).toBe(authenticated)
        if (!authenticated) expect(await recordOf(id)).toBeNull()
    })

    it.each([
        ['an unparsable createdAt', 'abc'],
        ['a createdAt beyond the clock skew', new Date(Date.now() + 10 * 60_000).toISOString()],
    ])('%s ends the session', async (_label, createdAt) => {
        await save('bad-age', { createdAt })

        expect(await authenticates('bad-age')).toBe(false)
        expect(await recordOf('bad-age')).toBeNull()
    })
})

describe.skipIf(!hasRedis)(
    'the same session lifetime for WebSocket messages (feat-119, F1)',
    () => {
        const DAY_MS = 24 * 3600 * 1000

        it('a message of a session past SESSION_MAX_AGE_DAYS is refused, and the record deleted', async () => {
            const { wsSessionHandler } = await import('./session-handler.js')
            await save('ws-old', { createdAt: new Date(Date.now() - 31 * DAY_MS).toISOString() })

            expect(await wsSessionHandler('ws-old', USER_TOKEN)).toEqual({ kind: 'missing' })
            // Gone: a later message cannot slide its TTL either.
            expect(await recordOf('ws-old')).toBeNull()
        })

        it('a message of a younger session is accepted and keeps the record', async () => {
            const { wsSessionHandler } = await import('./session-handler.js')
            await save('ws-young', { createdAt: new Date(Date.now() - 29 * DAY_MS).toISOString() })

            expect((await wsSessionHandler('ws-young', USER_TOKEN)).kind).toBe('ok')
            expect(await recordOf('ws-young')).not.toBeNull()
        })
    },
)

describe.skipIf(!hasRedis)('OAuth callback after a logout in another tab (feat-119, F2)', () => {
    it('state read, then logout: no sign-in, no new signed-in session', async () => {
        await save('cb', {
            data: { oauthState: 'state-1', oauthCodeVerifier: 'verifier', oauthProvider: 'google' },
        })
        const { default: OAuthController } =
            await import('#app/controllers/http/auth/oauth-controller.js')
        const request = createRequest('cb')
        request.context.httpData.params = { provider: 'google' }
        request.context.httpData.query = { code: 'code-1', state: 'state-1' } as never
        expect(await executeMiddlewares(['session_web'], request.context)).toBe(true)
        // The barrier: this request has read the state; the logout lands now.
        await admin.del(`session:${USER_TOKEN}:cb`)

        const payload = await OAuthController.callback(request.context as never)

        expect(oauthCallback).not.toHaveBeenCalled()
        expect(request.responseData.status).toBe(302)
        expect(payload).toMatchObject({ code: 'unauthorized', reason: 'session_revoked' })
        // Nothing was signed in: the deleted record stays deleted and no other appeared.
        expect(await recordOf('cb')).toBeNull()
        expect(await admin.keys(`session:${USER_TOKEN}:*`)).toEqual([])
    })

    it('with the session intact, the state is consumed before the sign-in runs', async () => {
        await save('cb-ok', {
            data: { oauthState: 'state-1', oauthCodeVerifier: 'verifier', oauthProvider: 'google' },
        })
        const { Result } = await import('better-result')
        let stateDuringSignIn: unknown = 'not called'
        oauthCallback.mockImplementation(async () => {
            stateDuringSignIn = (await recordOf('cb-ok'))?.data['oauthState']
            return Result.ok({ redirectUrl: '/?oauth=success' })
        })
        const { default: OAuthController } =
            await import('#app/controllers/http/auth/oauth-controller.js')
        const request = createRequest('cb-ok')
        request.context.httpData.params = { provider: 'google' }
        request.context.httpData.query = { code: 'code-1', state: 'state-1' } as never
        expect(await executeMiddlewares(['session_web'], request.context)).toBe(true)

        await OAuthController.callback(request.context as never)

        expect(oauthCallback).toHaveBeenCalledTimes(1)
        expect(stateDuringSignIn).toBeUndefined()
        expect(request.responseData.status).toBe(302)
    })
})

describe.skipIf(!hasRedis)(
    'OAuth state is consumed by one callback only (review of feat-119)',
    () => {
        const callbackRequest = (id: string, state: string) => {
            const request = createRequest(id)
            request.context.httpData.params = { provider: 'google' }
            request.context.httpData.query = { code: 'code-1', state } as never
            return request
        }

        it('two callbacks with the same state: exactly one goes on', async () => {
            await save('twice', {
                data: { oauthState: 'A', oauthCodeVerifier: 'vA', oauthProvider: 'google' },
            })
            const { Result } = await import('better-result')
            oauthCallback.mockResolvedValue(Result.ok({ redirectUrl: '/?oauth=success' }))
            const { default: OAuthController } =
                await import('#app/controllers/http/auth/oauth-controller.js')
            const first = callbackRequest('twice', 'A')
            const second = callbackRequest('twice', 'A')
            // Both read the session (snapshot A) before either consumes it.
            expect(await executeMiddlewares(['session_web'], first.context)).toBe(true)
            expect(await executeMiddlewares(['session_web'], second.context)).toBe(true)

            const payloads = await Promise.all([
                OAuthController.callback(first.context as never),
                OAuthController.callback(second.context as never),
            ])

            expect(oauthCallback).toHaveBeenCalledTimes(1)
            expect(payloads.filter((payload) => payload.status === 'success')).toHaveLength(1)
            expect(payloads).toContainEqual(
                expect.objectContaining({ message: 'OAuth state was already used or replaced' }),
            )
            expect((await recordOf('twice'))?.data['oauthState']).toBeUndefined()
        })

        it('a late callback with state A after a new start wrote B: it stops and B stays', async () => {
            await save('replaced', {
                data: { oauthState: 'A', oauthCodeVerifier: 'vA', oauthProvider: 'google' },
            })
            const { default: OAuthController } =
                await import('#app/controllers/http/auth/oauth-controller.js')
            const late = callbackRequest('replaced', 'A')
            expect(await executeMiddlewares(['session_web'], late.context)).toBe(true)
            // A new OAuth start in another tab, after the late callback read A.
            await storage.updateSessionData(
                'replaced',
                { oauthState: 'B', oauthCodeVerifier: 'vB', oauthProvider: 'google' },
                USER_TOKEN,
            )

            const payload = await OAuthController.callback(late.context as never)

            expect(oauthCallback).not.toHaveBeenCalled()
            expect(payload).toMatchObject({ message: 'OAuth state was already used or replaced' })
            expect((await recordOf('replaced'))?.data).toMatchObject({
                oauthState: 'B',
                oauthCodeVerifier: 'vB',
                oauthProvider: 'google',
            })
        })

        // feat-200 (L-7): the state belongs to the provider it was issued for.
        it('a state issued for another provider is refused and stays for its own callback', async () => {
            await save('mixup', {
                data: { oauthState: 'A', oauthCodeVerifier: 'vA', oauthProvider: 'github' },
            })
            const { default: OAuthController } =
                await import('#app/controllers/http/auth/oauth-controller.js')
            // The callback of google, with the state the session holds for github.
            const wrong = callbackRequest('mixup', 'A')
            expect(await executeMiddlewares(['session_web'], wrong.context)).toBe(true)

            const payload = await OAuthController.callback(wrong.context as never)

            expect(oauthCallback).not.toHaveBeenCalled()
            expect(payload).toMatchObject({ message: 'OAuth state mismatch' })
            expect((await recordOf('mixup'))?.data).toMatchObject({
                oauthState: 'A',
                oauthCodeVerifier: 'vA',
                oauthProvider: 'github',
            })
        })

        it('the store: of 10 concurrent consumers of one value exactly one wins', async () => {
            await save('race', {
                data: { oauthState: 'A', oauthCodeVerifier: 'vA', oauthProvider: 'google' },
            })

            const results = await Promise.all(
                Array.from({ length: 10 }, () =>
                    storage.consumeSessionData('race', USER_TOKEN, { oauthState: 'A' }, [
                        'oauthState',
                        'oauthCodeVerifier',
                    ]),
                ),
            )

            expect(results.filter((result) => result.kind === 'consumed')).toHaveLength(1)
            expect(results.filter((result) => result.kind === 'mismatch')).toHaveLength(9)
            expect((await recordOf('race'))?.data).not.toHaveProperty('oauthState')
        })
    },
)

describe.skipIf(!hasRedis)(
    'session.isStored for operations that do not write (feat-123, L5)',
    () => {
        it('is true while the record exists and false after a logout in another tab', async () => {
            await save('stored')
            const request = createRequest('stored')
            expect(await executeMiddlewares(['session_web', 'auth_guard'], request.context)).toBe(
                true,
            )

            expect(await request.context.session.isStored()).toBe(true)
            // The logout in another tab: the record goes, users.session_token stays.
            await admin.del(`session:${USER_TOKEN}:stored`)
            expect(await request.context.session.isStored()).toBe(false)
        })
    },
)
