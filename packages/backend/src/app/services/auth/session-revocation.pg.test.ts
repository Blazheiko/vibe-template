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

// feat-129: the session-still-stored guard is required; these cases keep the session.
const sessionStillStored = (): Promise<boolean> => Promise.resolve(true)

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
    return {
        ...actual,
        // What the real one answers when Redis is unreachable: nothing deleted, not complete.
        destroyAllSessions: (...args: Parameters<typeof actual.destroyAllSessions>) => {
            if (cleanup.fail) return Promise.resolve({ deleted: 0, complete: false })
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
            const changed = await authService.changePassword(
                user.id,
                { currentPassword: OLD_PASSWORD, newPassword: 'new-secret-456' },
                ctxA.auth.getPresentedUserToken(),
                sessionStillStored,
            )
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
            const changed = await authService.changePassword(
                user.id,
                { currentPassword: OLD_PASSWORD, newPassword: 'new-secret-456' },
                user.sessionToken,
                sessionStillStored,
            )
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

            const changed = await authService.changePassword(
                user.id,
                { currentPassword: OLD_PASSWORD, newPassword: 'new-secret-456' },
                user.sessionToken,
                sessionStillStored,
            )

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
                authService.changePassword(
                    user.id,
                    { currentPassword: OLD_PASSWORD, newPassword: 'winner-one-111' },
                    user.sessionToken,
                    sessionStillStored,
                ),
                authService.changePassword(
                    user.id,
                    { currentPassword: OLD_PASSWORD, newPassword: 'winner-two-222' },
                    user.sessionToken,
                    sessionStillStored,
                ),
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

    // feat-096: the token a request presented, as RequestSession.restore verified it.
    describe('the presented user token', () => {
        it('is the token of the signed-in cookie, and stays it after a login in the request', async () => {
            const user = await insertUser('presented-login')
            const other = await insertUser('presented-other')
            const a = await signIn(user)
            const { context } = await requestWith(a.cookie)
            expect(context.auth.getPresentedUserToken()).toBe(user.sessionToken)

            await context.auth.login(String(other.id), other.sessionToken)

            expect(context.auth.getUserId()).toBe(String(other.id))
            expect(context.auth.getPresentedUserToken()).toBe(user.sessionToken)
        })

        it('stays the initial one after the session is renewed under a new token', async () => {
            const user = await insertUser('presented-renew')
            const a = await signIn(user)
            const { context } = await requestWith(a.cookie)
            const changed = await authService.changePassword(
                user.id,
                { currentPassword: OLD_PASSWORD, newPassword: 'new-secret-456' },
                context.auth.getPresentedUserToken(),
                sessionStillStored,
            )
            if (!Result.isOk(changed)) throw new Error('password change failed')
            const renewed = await authService.renewSession(
                context.auth,
                context.session,
                changed.value.sessionToken,
            )
            expect(Result.isOk(renewed)).toBe(true)

            expect(context.auth.getPresentedUserToken()).toBe(user.sessionToken)
        })

        it('is undefined for an anonymous request and for a revoked session', async () => {
            const user = await insertUser('presented-revoked')
            const a = await signIn(user)
            const { context: anonymous } = newContext()
            await sessionHandler(anonymous, undefined, undefined)
            expect(anonymous.auth.getPresentedUserToken()).toBeUndefined()

            await userRepository.update(user.id, {
                sessionToken: `rotated${String(now)}`.slice(0, 24),
            })

            const { context } = await requestWith(a.cookie)
            expect(context.auth.check()).toBe(false)
            expect(context.auth.getPresentedUserToken()).toBeUndefined()
        })
    })

    // feat-096: a request let in before a revocation must not change credentials after it.
    // The revocation here is what a claim does to the row (password NULL, token rotated);
    // the claim itself comes with feat-097.
    describe('a change of credentials let in before a revocation', () => {
        const revokeLikeAClaim = async (id: bigint): Promise<string> => {
            const rotated = `claim${String(Date.now())}${String(id)}`.slice(0, 24)
            await userRepository.update(id, { password: null, sessionToken: rotated })
            return rotated
        }

        it('refuses a password change that reads the row after the revocation', async () => {
            const user = await insertUser('admitted-change-after')
            const a = await signIn(user)
            // The request passed the session check ...
            const { context } = await requestWith(a.cookie)
            expect(context.auth.check()).toBe(true)
            // ... the revocation commits ...
            const rotated = await revokeLikeAClaim(user.id)

            // ... and the request goes on: it reads password NULL, so it would not ask for
            // the current one.
            const result = await authService.changePassword(
                user.id,
                { newPassword: 'attacker-secret-1' },
                context.auth.getPresentedUserToken(),
                sessionStillStored,
            )

            expect(Result.isError(result) && result.error).toMatchObject({
                _tag: 'Unauthorized',
                reason: 'session_revoked',
            })
            const [row] = await db.select().from(users).where(eq(users.id, user.id))
            expect(row?.password).toBeNull()
            expect(row?.sessionToken).toBe(rotated)
        })

        it('refuses a password change whose read came before the revocation', async () => {
            const user = await insertUser('admitted-change-before')
            const a = await signIn(user)
            const { context } = await requestWith(a.cookie)
            let rotated = ''
            const realFindById = userRepository.findById.bind(userRepository)
            vi.spyOn(userRepository, 'findById').mockImplementationOnce(async (id) => {
                const row = await realFindById(id)
                rotated = await revokeLikeAClaim(user.id)
                return row
            })

            const result = await authService.changePassword(
                user.id,
                { currentPassword: OLD_PASSWORD, newPassword: 'attacker-secret-1' },
                context.auth.getPresentedUserToken(),
                sessionStillStored,
            )

            expect(Result.isError(result)).toBe(true)
            const [row] = await db.select().from(users).where(eq(users.id, user.id))
            expect(row?.password).toBeNull()
            expect(row?.sessionToken).toBe(rotated)
        })

        it('refuses logout everywhere after the revocation, keeping the new token', async () => {
            const user = await insertUser('admitted-logout-all')
            const a = await signIn(user)
            const { context } = await requestWith(a.cookie)
            const rotated = await revokeLikeAClaim(user.id)

            const result = await authService.logoutAll(context.auth, context.session)

            expect(Result.isError(result) && result.error).toMatchObject({
                reason: 'session_revoked',
            })
            expect(await dbToken(user.id)).toBe(rotated)
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

        it('succeeds and has revoked everything when the Redis cleanup fails', async () => {
            const user = await insertUser('rev-logout-all-down')
            const a = await signIn(user)
            const b = await signIn(user)
            const { context: ctxA } = await requestWith(a.cookie)
            cleanup.fail = true

            // feat-101: the rotation is the revocation, the cleanup only memory.
            const result = await authService.logoutAll(ctxA.auth, ctxA.session)
            expect(Result.isOk(result) && result.value.deletedCount).toBe(0)
            expect(ctxA.auth.check()).toBe(false)
            // The records are still in Redis ...
            expect(await getSession(a.sessionId, user.sessionToken)).not.toBeNull()
            expect(await getSession(b.sessionId, user.sessionToken)).not.toBeNull()
            cleanup.fail = false
            // ... and refused anyway.
            expect(await dbToken(user.id)).not.toBe(user.sessionToken)
            expect((await requestWith(a.cookie)).context.auth.check()).toBe(false)
            expect((await requestWith(b.cookie)).context.auth.check()).toBe(false)
        })
    })

    // feat-195 (M-1): a WebSocket connection that only pings is never checked against the
    // session, so a revoked session kept its sockets and the broadcasts sent to them. The real
    // registry holds fake sockets here; everything else runs unchanged.
    describe('WebSocket connections of a revoked session', async () => {
        const { wsConnectionRegistry } = await import('#app/websocket/ws-connection-registry.js')
        const { wsSessionRevocation } = await import('#app/services/auth/ws-session-revocation.js')
        const { passwordResetService } =
            await import('#app/services/auth/password-reset-service.js')
        const { passwordResetRepository } = await import('#app/repositories/index.js')
        const { hashToken } = await import('#app/services/auth/one-time-token.js')

        let socketCounter = 0
        const opened: { userId: string; uuid: string }[] = []

        // A connection opened from a signed-in session, as handleConnected registers it.
        const openSocket = (userId: bigint, sessionId: string, userToken: string) => {
            socketCounter += 1
            const uuid = `rev-socket-${String(socketCounter)}`
            const closedWith: number[] = []
            const sent: string[] = []
            const ws = {
                cork: (fn: () => void): void => {
                    fn()
                },
                send: (message: string): void => {
                    sent.push(message)
                },
                end: (code: number): void => {
                    closedWith.push(code)
                    // What uWS does next: the close handler takes it out of the registry.
                    wsConnectionRegistry.unregisterConnection(String(userId), uuid)
                },
            }
            wsConnectionRegistry.registerConnection(String(userId), uuid, ws as never, {
                ip: '203.0.113.9',
                userAgent: 'test',
                appType: 'web',
                sessionId,
                userToken,
            })
            opened.push({ userId: String(userId), uuid })
            return { closedWith, sent }
        }

        afterEach(() => {
            for (const { userId, uuid } of opened.splice(0)) {
                wsConnectionRegistry.unregisterConnection(userId, uuid)
            }
        })

        it('logout closes the sockets of that session and leaves the other sessions alone', async () => {
            const user = await insertUser('rev-ws-logout')
            const a = await signIn(user)
            const b = await signIn(user)
            const socketA = openSocket(user.id, a.sessionId, user.sessionToken)
            const socketB = openSocket(user.id, b.sessionId, user.sessionToken)

            const { context } = await requestWith(a.cookie)
            const result = await authService.logout(context.auth, context.session)

            expect(Result.isOk(result)).toBe(true)
            expect(socketA.closedWith).toEqual([4001])
            expect(JSON.parse(String(socketA.sent[0]))).toMatchObject({
                event: 'service:error',
                error: { code: 'unauthorized' },
            })
            expect(socketB.closedWith).toEqual([])
            expect(wsConnectionRegistry.isUserOnline(String(user.id))).toBe(true)
        })

        it('logout everywhere closes every socket of the user and no one else', async () => {
            const user = await insertUser('rev-ws-logout-all')
            const bystander = await insertUser('rev-ws-bystander')
            const a = await signIn(user)
            const b = await signIn(user)
            const c = await signIn(bystander)
            const socketA = openSocket(user.id, a.sessionId, user.sessionToken)
            const socketB = openSocket(user.id, b.sessionId, user.sessionToken)
            const socketC = openSocket(bystander.id, c.sessionId, bystander.sessionToken)

            const { context } = await requestWith(a.cookie)
            const result = await authService.logoutAll(context.auth, context.session)

            expect(Result.isOk(result)).toBe(true)
            expect(socketA.closedWith).toEqual([4001])
            expect(socketB.closedWith).toEqual([4001])
            expect(socketC.closedWith).toEqual([])
            expect(wsConnectionRegistry.isUserOnline(String(user.id))).toBe(false)
        })

        it('a password change closes every socket of the user', async () => {
            const user = await insertUser('rev-ws-change')
            const a = await signIn(user)
            const b = await signIn(user)
            const socketA = openSocket(user.id, a.sessionId, user.sessionToken)
            const socketB = openSocket(user.id, b.sessionId, user.sessionToken)

            const { context } = await requestWith(a.cookie)
            const changed = await authService.changePassword(
                user.id,
                { currentPassword: OLD_PASSWORD, newPassword: 'new-secret-456' },
                context.auth.getPresentedUserToken(),
                sessionStillStored,
            )

            expect(Result.isOk(changed)).toBe(true)
            expect(socketA.closedWith).toEqual([4001])
            expect(socketB.closedWith).toEqual([4001])
        })

        it('a password reset by email closes every socket of the user', async () => {
            const user = await insertUser('rev-ws-reset')
            const a = await signIn(user)
            const socketA = openSocket(user.id, a.sessionId, user.sessionToken)
            const token = `reset-${crypto.randomUUID()}`
            await passwordResetRepository.create({
                userId: user.id,
                tokenHash: hashToken(token),
                targetEmail: user.email,
                expiresAt: new Date(Date.now() + 600_000),
            })

            const result = await passwordResetService.resetPassword(
                token,
                'reset-secret-789',
                'reset-secret-789',
                { ipAddress: '203.0.113.9' },
            )

            expect(Result.isError(result) ? result.error : null).toBeNull()
            expect(socketA.closedWith).toEqual([4001])
        })

        it('the re-check closes a socket whose token was rotated by another instance', async () => {
            const user = await insertUser('rev-ws-recheck')
            const bystander = await insertUser('rev-ws-recheck-bystander')
            const a = await signIn(user)
            const c = await signIn(bystander)
            const stale = openSocket(user.id, a.sessionId, user.sessionToken)
            const current = openSocket(bystander.id, c.sessionId, bystander.sessionToken)

            // Nothing rotated yet: the pass keeps both.
            await wsSessionRevocation.recheckSessions()
            expect(stale.closedWith).toEqual([])

            // Another instance revoked the session: only the database knows.
            await db
                .update(users)
                .set({ sessionToken: 'rotated-elsewhere-0001' })
                .where(eq(users.id, user.id))

            const report = await wsSessionRevocation.recheckSessions()

            expect(report.closed).toBe(1)
            expect(report.failed).toBe(0)
            expect(stale.closedWith).toEqual([4001])
            expect(current.closedWith).toEqual([])
        })

        it('the re-check closes the sockets of a deleted user', async () => {
            const user = await insertUser('rev-ws-deleted')
            const a = await signIn(user)
            const socket = openSocket(user.id, a.sessionId, user.sessionToken)
            await db.delete(users).where(eq(users.id, user.id))

            await wsSessionRevocation.recheckSessions()

            expect(socket.closedWith).toEqual([4001])
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
