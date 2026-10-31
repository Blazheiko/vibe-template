import type { Redis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import {
    cleanupTestRedis,
    createTestRedis,
    hasRedis,
} from '../../../test-support/redis-test-client.js'

// The route chain of POST /api/auth/logout-all: session_web → csrf_guard →
// auth_guard → AuthController.logoutAll, on the production main-client contract
// against a real Redis. ADR 0002: logout-all first rotates users.sessionToken, so a
// run stopped by Redis has already revoked every session; the 503 only reports that
// the records could not be deleted yet (they are memory, cleaned up later).
// The users table is a Map here; the real database is in session-revocation.pg.test.ts.

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

// users.sessionToken by user id: what logout-all rotates and the guard compares.
const fakeUsers = vi.hoisted(() => ({ tokens: new Map<string, string>() }))
vi.mock('#app/repositories/index.js', async (importActual) => {
    const actual = await importActual<Record<string, unknown>>()
    return {
        ...actual,
        userRepository: {
            findSessionToken: (id: bigint) => Promise.resolve(fakeUsers.tokens.get(String(id))),
            update: (id: bigint, data: { sessionToken?: string }) => {
                if (data.sessionToken !== undefined) {
                    fakeUsers.tokens.set(String(id), data.sessionToken)
                }
                return Promise.resolve({ id })
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
const { default: AuthController } = await import('#app/controllers/http/auth/auth-controller.js')
const { registerSessionTokenChecker } = await import('./session-token-check.js')
const { checkSessionToken } = await import('#app/services/auth/session-token-check.js')

registerSessionTokenChecker(checkSessionToken)

const admin = createTestRedis(PREFIX)
const USER_TOKEN = 'logoutAllRetryToken01'
const CSRF = 'c'.repeat(43)
const ROUTE_MIDDLEWARES = ['session_web', 'csrf_guard', 'auth_guard']

const save = (id: string) =>
    storage.saveSession({
        id,
        data: { userId: '42', userToken: USER_TOKEN, csrfToken: CSRF },
        createdAt: new Date().toISOString(),
    })

const userSessions = async (): Promise<string[]> =>
    (await admin.keys(`${PREFIX}session:${USER_TOKEN}:*`)).sort()

/** Context of POST /api/auth/logout-all with the session cookie and CSRF header. */
const createRequest = () => {
    const cookie = createSignedToken(`${USER_TOKEN}.current`)
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

/** One request through the route's middleware chain and controller. */
const logoutAllRequest = async () => {
    const { context, responseData } = createRequest()
    const passed = await executeMiddlewares(ROUTE_MIDDLEWARES, context)
    const payload = passed ? await AuthController.logoutAll(context as never) : responseData.payload
    return { passed, status: responseData.status, payload }
}

const pause = () => admin.call('CLIENT', 'PAUSE', '10000', 'WRITE')
const unpause = () => admin.call('CLIENT', 'UNPAUSE')

beforeAll(async () => {
    if (!hasRedis) return
    await admin.connect()
    await client.connect()
})
afterAll(async () => {
    if (!hasRedis) return
    await unpause()
    await cleanupTestRedis(admin)
    redisHealth.stop()
    client.disconnect(false)
    await admin.quit()
})

describe.skipIf(!hasRedis)('logoutAll repeated after a stopped run', () => {
    it('a run stopped by Redis answers 503, but the sessions are already revoked', async () => {
        fakeUsers.tokens.set('42', USER_TOKEN)
        for (const id of ['phone', 'tablet', 'current', 'laptop']) await save(id)

        // Middleware (GETEX of the session) runs before the pause; the pause then
        // stops the first DEL of the cleanup loop, after the sessionToken rotation.
        const { context, responseData } = createRequest()
        expect(await executeMiddlewares(ROUTE_MIDDLEWARES, context)).toBe(true)
        await pause()
        let first: unknown
        try {
            first = await AuthController.logoutAll(context as never)
        } finally {
            await unpause()
        }
        expect(responseData.status).toBe(503)
        expect(first).toMatchObject({ code: 'service_unavailable' })
        expect(first).not.toHaveProperty('deletedCount')
        // The records survived the stop ...
        expect(await userSessions()).toContain(`${PREFIX}session:${USER_TOKEN}:current`)
        expect(fakeUsers.tokens.get('42')).not.toBe(USER_TOKEN)

        // ... but none of them opens anything. The repeated POST is refused by csrf_guard,
        // which sits before auth_guard: the replacement anonymous session has another
        // CSRF token, the same answer a session deleted from Redis gets.
        const repeat = await logoutAllRequest()
        expect(repeat.passed).toBe(false)
        expect(repeat.status).toBe(403)
        // Past CSRF, auth_guard refuses it: a session the stop never touched ('laptop')
        // and the caller's own ('current') are both anonymous now.
        for (const id of ['laptop', 'current']) {
            const probe = createRequest()
            probe.context.httpData.cookies.set(
                sessionConfig.cookieName,
                createSignedToken(`${USER_TOKEN}.${id}`),
            )
            expect(await executeMiddlewares(['session_web', 'auth_guard'], probe.context)).toBe(
                false,
            )
            expect(probe.responseData.status).toBe(401)
        }

        // What is left is memory; a later full cleanup (password reset does this) clears it.
        await storage.destroyAllSessions(USER_TOKEN)
        expect(await userSessions()).toEqual([])
        expect(await admin.exists(`logout_all:cursor:${USER_TOKEN}`)).toBe(0)
    })

    it('password reset after a stopped logoutAll still revokes the skipped session', async () => {
        // Enough keys for several SCAN pages (COUNT 100).
        for (let i = 0; i < 300; i++) await save(`s${String(i)}`)

        // The state a stopped interactive run leaves. Redis does not say which
        // page a key lands on, so the skipped ("current") session is picked from
        // the first non-last page that has user sessions: the other keys of that
        // page are deleted, the cursor points past it.
        const sessionPrefix = `${PREFIX}session:${USER_TOKEN}:`
        let cursor = '0'
        let skippedId: string | undefined
        do {
            const [next, keys] = await admin.scan(
                cursor,
                'MATCH',
                `${sessionPrefix}*`,
                'COUNT',
                100,
            )
            if (next !== '0' && keys.length > 0) {
                skippedId = keys[0]?.slice(sessionPrefix.length)
                const others = keys.slice(1).map((k) => k.slice(PREFIX.length))
                if (others.length > 0) await admin.del(...others)
            }
            cursor = next
        } while (skippedId === undefined && cursor !== '0')
        if (skippedId === undefined) {
            throw new Error('setup: SCAN returned all sessions on its last page')
        }
        // Both the per-session key and the shared one 813c3f6 used: full
        // revocation must ignore any saved cursor.
        await admin.setex(`logout_all:cursor:${USER_TOKEN}:${skippedId}`, 600, cursor)
        await admin.setex(`logout_all:cursor:${USER_TOKEN}`, 600, cursor)

        // What password-reset-service calls: full revocation, no kept session.
        await storage.destroyAllSessions(USER_TOKEN)

        expect(await userSessions()).toEqual([])
    })
})
