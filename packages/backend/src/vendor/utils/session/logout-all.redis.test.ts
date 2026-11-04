import type { Redis } from 'ioredis'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import {
    cleanupTestRedis,
    createTestRedis,
    hasRedis,
} from '../../../test-support/redis-test-client.js'

// destroyAllSessions and POST /api/auth/logout-all (session_web → csrf_guard →
// auth_guard → AuthController.logoutAll) on the production main-client contract against a
// real Redis. ADR 0002: logout-all first rotates users.sessionToken, so the sessions are
// revoked before the cleanup starts; a cleanup stopped by Redis is memory left behind and
// does not fail the request (feat-101). The users table is a Map here; the real database
// is in session-revocation*.pg.test.ts.

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
const { default: redisConfig } = (await import('#config/redis.js')) as unknown as {
    default: { logoutAllDeadlineMs: number; commandTimeoutMs: number }
}
const { default: executeMiddlewares } =
    await import('#vendor/utils/middlewares/core/execute-httpMiddlewares.js')
const { default: createContext } = await import('#vendor/utils/context/http-context.js')
const { createResponseData } = await import('#vendor/utils/network/response-data.js')
const { default: AuthController } = await import('#app/controllers/http/auth/auth-controller.js')
const { registerSessionTokenChecker } = await import('./session-token-check.js')
const { checkSessionToken } = await import('#app/services/auth/session-token-check.js')

registerSessionTokenChecker(checkSessionToken)

const admin = createTestRedis(PREFIX)
const USER_TOKEN = 'logoutAllUserToken01'
const OTHER_TOKEN = 'logoutAllOtherToken1'
const CSRF = 'c'.repeat(43)
const ROUTE_MIDDLEWARES = ['session_web', 'csrf_guard', 'auth_guard']
const DEFAULT_DEADLINE_MS = redisConfig.logoutAllDeadlineMs

const save = (id: string, userToken = USER_TOKEN) =>
    storage.saveSession({
        id,
        data: { userId: '42', userToken, csrfToken: CSRF },
        createdAt: new Date().toISOString(),
    })

const sessionsOf = async (userToken = USER_TOKEN): Promise<string[]> =>
    (await admin.keys(`${PREFIX}session:${userToken}:*`)).sort()

/** Context of POST /api/auth/logout-all with the session cookie and CSRF header. */
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

const pause = () => admin.call('CLIENT', 'PAUSE', '10000', 'WRITE')
const unpause = () => admin.call('CLIENT', 'UNPAUSE')

beforeAll(async () => {
    if (!hasRedis) return
    await admin.connect()
    await client.connect()
})
beforeEach(async () => {
    if (!hasRedis) return
    vi.restoreAllMocks()
    security.mockClear()
    redisConfig.logoutAllDeadlineMs = DEFAULT_DEADLINE_MS
    await cleanupTestRedis(admin)
})
afterAll(async () => {
    if (!hasRedis) return
    await unpause()
    await cleanupTestRedis(admin)
    redisHealth.stop()
    client.disconnect(false)
    await admin.quit()
})

describe.skipIf(!hasRedis)('destroyAllSessions on a real Redis', () => {
    it('deletes every session of the user and nothing of another user', async () => {
        for (let i = 0; i < 250; i++) await save(`s${String(i)}`)
        for (const id of ['x', 'y']) await save(id, OTHER_TOKEN)

        await expect(storage.destroyAllSessions(USER_TOKEN)).resolves.toEqual({
            deleted: 250,
            complete: true,
        })

        expect(await sessionsOf()).toEqual([])
        expect(await sessionsOf(OTHER_TOKEN)).toHaveLength(2)
        // No retry cursor any more.
        expect(await admin.keys(`${PREFIX}logout_all:*`)).toEqual([])
    })

    it('a stop after several DELs reports the confirmed deletions, complete: false', async () => {
        // Enough keys for several SCAN pages (COUNT 100).
        for (let i = 0; i < 300; i++) await save(`s${String(i)}`)
        let dels = 0
        const realDel = client.del.bind(client)
        const del = async (...keys: string[]): Promise<number> => {
            dels += 1
            // The third DEL hits paused writes and times out.
            if (dels === 3) await pause()
            return realDel(...keys)
        }
        vi.spyOn(client, 'del').mockImplementation(del as never)

        let result: Awaited<ReturnType<typeof storage.destroyAllSessions>>
        let left: string[]
        try {
            result = await storage.destroyAllSessions(USER_TOKEN)
            // Read while writes are still paused: the stopped DEL has not run yet.
            left = await sessionsOf()
        } finally {
            await unpause()
        }

        expect(result.complete).toBe(false)
        expect(dels).toBe(3)
        expect(result.deleted).toBeGreaterThan(0)
        expect(result.deleted).toBe(300 - left.length)
        // Not a number to rely on: the DEL Redis held back runs after the unpause.
        await vi.waitFor(async () => {
            expect((await sessionsOf()).length).toBeLessThan(left.length)
        })
    })

    it('a failing first SCAN deletes nothing and reports complete: false', async () => {
        for (const id of ['a', 'b']) await save(id)
        const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
        vi.spyOn(client, 'scan').mockRejectedValueOnce(refused)

        await expect(storage.destroyAllSessions(USER_TOKEN)).resolves.toEqual({
            deleted: 0,
            complete: false,
        })
        expect(await sessionsOf()).toHaveLength(2)
    })

    it('stops at the deadline, before the command timeout', async () => {
        await save('a')
        redisConfig.logoutAllDeadlineMs = 150
        expect(redisConfig.commandTimeoutMs).toBeGreaterThan(300)

        await pause()
        const start = Date.now()
        let result: Awaited<ReturnType<typeof storage.destroyAllSessions>>
        try {
            result = await storage.destroyAllSessions(USER_TOKEN)
        } finally {
            await unpause()
        }

        expect(result).toEqual({ deleted: 0, complete: false })
        expect(Date.now() - start).toBeLessThan(300)
    })
})

describe.skipIf(!hasRedis)('POST /api/auth/logout-all when the cleanup stops', () => {
    it('answers 200 with a new anonymous session; the left records open nothing', async () => {
        fakeUsers.tokens.set('42', USER_TOKEN)
        for (const id of ['phone', 'tablet', 'current', 'laptop']) await save(id)

        // Middleware (GETEX of the session) runs before the pause; the pause then
        // stops the first DEL of the cleanup, after the sessionToken rotation.
        const { context, responseData } = createRequest()
        expect(await executeMiddlewares(ROUTE_MIDDLEWARES, context)).toBe(true)
        await pause()
        let payload: unknown
        try {
            payload = await AuthController.logoutAll(context as never)
        } finally {
            await unpause()
        }

        expect(payload).toEqual({
            status: 'success',
            deletedCount: 0,
            csrfToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        })
        expect((payload as { csrfToken: string }).csrfToken).not.toBe(CSRF)
        expect(responseData.status).not.toBe(503)
        // The caller left with a new anonymous session and its cookie.
        expect(context.auth.check()).toBe(false)
        const cookie = responseData.cookies.get(sessionConfig.cookieName)
        expect(JSON.stringify(cookie)).not.toContain(USER_TOKEN)
        expect(security).toHaveBeenCalledWith(42n, 'logout_all')
        expect(fakeUsers.tokens.get('42')).not.toBe(USER_TOKEN)

        // Redis is back; the cleanup's DEL ran after the unpause or not, every old cookie
        // is anonymous now, the caller's and one the cleanup may never have reached.
        for (const id of ['current', 'laptop', 'phone', 'tablet']) {
            expect(await authenticates(id)).toBe(false)
        }

        // What is left is memory; a later full cleanup (password reset does this) clears it.
        await expect(storage.destroyAllSessions(USER_TOKEN)).resolves.toMatchObject({
            complete: true,
        })
        expect(await sessionsOf()).toEqual([])
        expect(await admin.keys(`${PREFIX}logout_all:*`)).toEqual([])
    })
})
