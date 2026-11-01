import { Result } from 'better-result'
import type { Redis } from 'ioredis'
import type * as SessionStorage from '#vendor/utils/session/redis-session-storage.js'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { hasPg } from '../../../test-support/pg-test-db.js'
import {
    cleanupTestRedis,
    createTestRedis,
    hasRedis,
} from '../../../test-support/redis-test-client.js'

// ADR 0002 against a real PostgreSQL and a real Redis. Sessions live in Redis and are
// revoked by rotating users.sessionToken in PostgreSQL; the real sessionHandler,
// wsSessionHandler, verifyUpgradeToken and authService run unchanged. Not under test
// here (own suites): throttling, notifications, CSRF.

const { PREFIX } = vi.hoisted(() => {
    process.env['APP_KEY'] ??= 'k'.repeat(16) + '3f9a1c7e5b2d4f60'
    return { PREFIX: `test:${crypto.randomUUID()}:` }
})

const silent = vi.hoisted(() => {
    const logger = {
        error: () => undefined,
        warn: () => undefined,
        info: () => undefined,
        debug: () => undefined,
        child: (): unknown => logger,
    }
    return logger
})
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
    return { default: client, redisHealth, withRedis: createWithRedis(client, redisHealth) }
})
vi.mock('#app/services/auth/auth-throttle-service.js', () => ({
    consumeAuthThrottle: () => Promise.resolve({ allowed: true, count: 1 }),
    resetAuthThrottle: () => Promise.resolve(undefined),
}))
vi.mock('#app/services/notifications/user-notification-service.js', () => ({
    userNotificationService: { security: vi.fn(), supportReply: vi.fn() },
}))

// The real storage with one switch: the cleanup (destroyAllSessions) can be made to fail
// the way an unreachable Redis makes it fail.
const cleanup = vi.hoisted(() => ({ fail: false }))
vi.mock('#vendor/utils/session/redis-session-storage.js', async (importActual) => {
    const actual = await importActual<typeof SessionStorage>()
    const { RedisUnavailableError } =
        await import('#vendor/utils/network/errors/redis-unavailable-error.js')
    return {
        ...actual,
        destroyAllSessions: (...args: Parameters<typeof actual.destroyAllSessions>) => {
            if (cleanup.fail) return Promise.reject(new RedisUnavailableError('cleanup failed'))
            return actual.destroyAllSessions(...args)
        },
    }
})

describe.skipIf(!hasPg || !hasRedis)('session revocation on PostgreSQL and Redis', async () => {
    const { db, pool } = await import('#database/db.js')
    const { sessionCheckPool } = await import('#database/session-check-db.js')
    const { users } = await import('#database/schema.js')
    const { default: client, redisHealth } = (await import('#database/redis.js')) as unknown as {
        default: Redis
        redisHealth: { stop(): void }
    }
    const { hashPassword, validatePassword } = await import('metautil')
    const { userRepository } = await import('#app/repositories/index.js')
    const { authService } = await import('#app/services/auth/auth-service.js')
    const { checkSessionToken } = await import('#app/services/auth/session-token-check.js')
    const { generateWsToken } = await import('#app/services/auth/generate-ws-token-service.js')
    const { wsSessionAuth } = await import('#app/websocket/ws-session-auth.js')
    const { sessionHandler, wsSessionHandler } =
        await import('#vendor/utils/session/session-handler.js')
    const { getSession } = await import('#vendor/utils/session/redis-session-storage.js')
    const { registerSessionTokenChecker } =
        await import('#vendor/utils/session/session-token-check.js')
    const { SessionVerificationUnavailableError } =
        await import('#vendor/utils/network/errors/session-verification-unavailable-error.js')
    const { createResponseData } = await import('#vendor/utils/network/response-data.js')
    const { default: createContext } = await import('#vendor/utils/context/http-context.js')
    const { default: sessionConfig } = await import('#config/session.js')

    registerSessionTokenChecker(checkSessionToken)

    const admin = createTestRedis(PREFIX)
    const now = Date.now()
    const OLD_PASSWORD = 'old-secret-123'
    const createdUserIds: bigint[] = []

    const insertUser = async (name: string) => {
        const [row] = await db
            .insert(users)
            .values({
                name,
                email: `${name}-${String(now)}@example.test`,
                password: await hashPassword(OLD_PASSWORD),
            })
            .returning()
        if (row === undefined) throw new Error('user not inserted')
        createdUserIds.push(row.id)
        return row
    }

    const newContext = () => {
        const responseData = createResponseData()
        const context = createContext(
            { method: 'get', headers: new Map(), cookies: new Map() } as never,
            responseData,
        )
        return { context, responseData }
    }

    const cookieOf = (responseData: ReturnType<typeof createResponseData>): string => {
        const cookie = responseData.cookies.get(sessionConfig.cookieName)?.value
        if (cookie === undefined) throw new Error('no session cookie issued')
        return cookie
    }

    // What authService.login ends with: a signed-in session under the user's token.
    const signIn = async (user: { id: bigint; sessionToken: string }) => {
        const { context, responseData } = newContext()
        await sessionHandler(context, undefined, undefined)
        await context.auth.login(String(user.id), user.sessionToken)
        const sessionInfo = context.session.sessionInfo
        if (sessionInfo === null) throw new Error('no session after login')
        return { context, cookie: cookieOf(responseData), sessionId: sessionInfo.id, sessionInfo }
    }

    const requestWith = async (cookie: string) => {
        const { context, responseData } = newContext()
        await sessionHandler(context, cookie, undefined)
        return { context, responseData }
    }

    const dbToken = async (id: bigint): Promise<string | undefined> =>
        userRepository.findSessionToken(id)

    beforeAll(async () => {
        await admin.connect()
        await client.connect()
    })

    afterEach(() => {
        cleanup.fail = false
        vi.restoreAllMocks()
    })

    afterAll(async () => {
        for (const id of createdUserIds) await db.delete(users).where(eq(users.id, id))
        await cleanupTestRedis(admin)
        redisHealth.stop()
        client.disconnect(false)
        await admin.quit()
        await sessionCheckPool.end()
        await pool.end()
    })

    describe('password change', () => {
        it('revokes every other session and renews the current one under the new token', async () => {
            const user = await insertUser('rev-change')
            const a = await signIn(user)
            const b = await signIn(user)
            expect((await requestWith(a.cookie)).context.auth.check()).toBe(true)
            expect((await requestWith(b.cookie)).context.auth.check()).toBe(true)

            // The request of session A: change the password, then renew its session.
            const { context: ctxA, responseData: responseA } = await requestWith(a.cookie)
            const changed = await authService.changePassword(user.id, {
                currentPassword: OLD_PASSWORD,
                newPassword: 'new-secret-456',
            })
            expect(Result.isOk(changed)).toBe(true)
            if (!Result.isOk(changed)) return
            const renewed = await authService.renewSession(
                ctxA.auth,
                ctxA.session,
                changed.value.sessionToken,
            )
            expect(Result.isOk(renewed)).toBe(true)
            if (!Result.isOk(renewed)) return

            // The old cookie of A and the cookie of B stop working.
            expect((await requestWith(a.cookie)).context.auth.check()).toBe(false)
            expect((await requestWith(b.cookie)).context.auth.check()).toBe(false)

            // The renewed session works, with a fresh CSRF token and WebSocket token.
            const renewedCookie = cookieOf(responseA)
            expect(renewedCookie).not.toBe(a.cookie)
            const next = await requestWith(renewedCookie)
            expect(next.context.auth.check()).toBe(true)
            expect(next.context.auth.getUserId()).toBe(String(user.id))
            expect(renewed.value.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/)
            expect(renewed.value.csrfToken).not.toBe(a.sessionInfo.data.csrfToken)
            expect(renewed.value.wsToken).not.toBe('')

            // The password and the token rotated together.
            expect(await dbToken(user.id)).toBe(changed.value.sessionToken)
            expect(changed.value.sessionToken).not.toBe(user.sessionToken)
            const [row] = await db.select().from(users).where(eq(users.id, user.id))
            expect(await validatePassword('new-secret-456', row?.password ?? '')).toBe(true)
        })

        it('rejects a WebSocket message and a WebSocket upgrade of a revoked session', async () => {
            const user = await insertUser('rev-ws')
            const session = await signIn(user)
            const wsToken = await generateWsToken(session.sessionInfo, String(user.id))
            expect((await wsSessionHandler(session.sessionId, user.sessionToken)).kind).toBe('ok')
            expect((await wsSessionAuth.verifyUpgradeToken(wsToken)).kind).toBe('ok')

            // The cleanup fails, so the Redis records stay: only the sessionToken check
            // can refuse them.
            cleanup.fail = true
            const changed = await authService.changePassword(user.id, {
                currentPassword: OLD_PASSWORD,
                newPassword: 'new-secret-456',
            })
            expect(Result.isOk(changed)).toBe(true)
            expect(await getSession(session.sessionId, user.sessionToken)).not.toBeNull()

            expect((await wsSessionHandler(session.sessionId, user.sessionToken)).kind).toBe(
                'missing',
            )
            expect((await wsSessionAuth.verifyUpgradeToken(wsToken)).kind).toBe('missing')
        })

        it('keeps the sessions revoked when the Redis cleanup fails, with no second cleanup', async () => {
            const user = await insertUser('rev-redis-down')
            const a = await signIn(user)
            const b = await signIn(user)
            cleanup.fail = true

            const changed = await authService.changePassword(user.id, {
                currentPassword: OLD_PASSWORD,
                newPassword: 'new-secret-456',
            })

            // The change itself succeeded; the records are still in Redis ...
            expect(Result.isOk(changed)).toBe(true)
            expect(await getSession(a.sessionId, user.sessionToken)).not.toBeNull()
            expect(await getSession(b.sessionId, user.sessionToken)).not.toBeNull()
            // ... and Redis is reachable again, but nothing cleaned them up: the very
            // first request of each is already refused, because the token was rotated.
            cleanup.fail = false
            expect((await requestWith(a.cookie)).context.auth.check()).toBe(false)
            expect((await requestWith(b.cookie)).context.auth.check()).toBe(false)
        })

        it('lets exactly one of two concurrent changes win', async () => {
            const user = await insertUser('rev-race')
            // Both requests read the user before either writes.
            const realFindById = userRepository.findById.bind(userRepository)
            let reads = 0
            let release: () => void = () => undefined
            const bothRead = new Promise<void>((resolve) => {
                release = resolve
            })
            vi.spyOn(userRepository, 'findById').mockImplementation(async (id) => {
                const row = await realFindById(id)
                reads += 1
                if (reads === 2) release()
                await bothRead
                return row
            })

            const [first, second] = await Promise.all([
                authService.changePassword(user.id, {
                    currentPassword: OLD_PASSWORD,
                    newPassword: 'winner-one-111',
                }),
                authService.changePassword(user.id, {
                    currentPassword: OLD_PASSWORD,
                    newPassword: 'winner-two-222',
                }),
            ])

            const results = [first, second]
            const winners = results.filter((result) => Result.isOk(result))
            const losers = results.filter((result) => Result.isError(result))
            expect(winners).toHaveLength(1)
            expect(losers).toHaveLength(1)
            const loser = losers[0]
            if (loser !== undefined && Result.isError(loser)) {
                expect(loser.error._tag).toBe('Conflict')
            }

            // The stored password and token are the winner's.
            const winner = winners[0]
            if (winner === undefined || !Result.isOk(winner)) return
            const [row] = await db.select().from(users).where(eq(users.id, user.id))
            const winnerPassword = Result.isOk(first) ? 'winner-one-111' : 'winner-two-222'
            expect(await validatePassword(winnerPassword, row?.password ?? '')).toBe(true)
            expect(row?.sessionToken).toBe(winner.value.sessionToken)
        })
    })

    describe('logout everywhere', () => {
        it('revokes every session, the current one included', async () => {
            const user = await insertUser('rev-logout-all')
            const a = await signIn(user)
            const b = await signIn(user)
            const { context: ctxA } = await requestWith(a.cookie)

            const result = await authService.logoutAll(ctxA.auth, ctxA.session)

            expect(Result.isOk(result)).toBe(true)
            expect(await dbToken(user.id)).not.toBe(user.sessionToken)
            expect((await requestWith(a.cookie)).context.auth.check()).toBe(false)
            expect((await requestWith(b.cookie)).context.auth.check()).toBe(false)
        })

        it('has already revoked everything when the Redis cleanup fails', async () => {
            const user = await insertUser('rev-logout-all-down')
            const a = await signIn(user)
            const b = await signIn(user)
            const { context: ctxA } = await requestWith(a.cookie)
            cleanup.fail = true

            const result = await authService.logoutAll(ctxA.auth, ctxA.session)

            // The request reports the failed cleanup, but the rotation came first.
            expect(Result.isError(result)).toBe(true)
            cleanup.fail = false
            expect(await dbToken(user.id)).not.toBe(user.sessionToken)
            expect((await requestWith(a.cookie)).context.auth.check()).toBe(false)
            expect((await requestWith(b.cookie)).context.auth.check()).toBe(false)
        })
    })

    describe('when the database cannot answer', () => {
        it('refuses a request instead of trusting the Redis record', async () => {
            const user = await insertUser('rev-db-down')
            const a = await signIn(user)
            vi.spyOn(userRepository, 'findSessionToken').mockRejectedValue(
                new Error('connection terminated'),
            )

            await expect(requestWith(a.cookie)).rejects.toBeInstanceOf(
                SessionVerificationUnavailableError,
            )
            expect((await wsSessionHandler(a.sessionId, user.sessionToken)).kind).toBe(
                'unavailable',
            )

            // The record was neither deleted nor trusted: once the database answers, the
            // same cookie works again.
            vi.restoreAllMocks()
            expect((await requestWith(a.cookie)).context.auth.check()).toBe(true)
        })

        it('treats a deleted user as revoked', async () => {
            const user = await insertUser('rev-deleted')
            const a = await signIn(user)
            await db.delete(users).where(eq(users.id, user.id))

            expect((await requestWith(a.cookie)).context.auth.check()).toBe(false)
        })
    })
})
