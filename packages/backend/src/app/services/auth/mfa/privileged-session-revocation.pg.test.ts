import type { Redis } from 'ioredis'
import type { NormalizedEmail } from '#app/domain/email.js'
import { and, eq, sql } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import type { Role } from 'shared/access'

import { hasPg } from '../../../../test-support/pg-test-db.js'
import { testAdminActor } from '../../../../test-support/audit-actor.js'
import { waitForLockWaiters } from '../../../../test-support/race-barrier.js'
import {
    cleanupTestRedis,
    createTestRedis,
    hasRedis,
} from '../../../../test-support/redis-test-client.js'
import type { UserId } from '#app/domain/ids.js'

// docs/plan/passkeys-mfa-plan.md (Р13), on a real PostgreSQL and a real Redis: ending one session
// of an administrator from the session list deletes its record without rotating
// users.session_token. A role change or an MFA reset of another account requested from that
// session reads the record under the administrator's row lock, and the revocation deletes it
// under the same lock: a revocation that came first refuses the write (401 session_revoked,
// nothing written); one that comes while the write holds the lock waits for its commit.

const { PREFIX } = vi.hoisted(() => {
    process.env['APP_KEY'] ??= 'k'.repeat(16) + '3f9a1c7e5b2d4f60'
    process.env['AUTH_OTP_HMAC_KEY'] ??= 'o'.repeat(32)
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
vi.mock('#app/services/notifications/user-notification-service.js', () => ({
    userNotificationService: { security: vi.fn(), supportReply: vi.fn() },
}))
vi.mock('#app/services/notifications/email-service.js', () => ({
    emailService: { send: () => Promise.resolve({ status: 'ok', value: { id: 'm' } }) },
}))
vi.mock('#app/services/auth/ws-session-revocation.js', () => ({
    wsSessionRevocation: { closeUserConnections: vi.fn(() => 0) },
}))
vi.mock('#app/services/communication/role-change-announcer.js', () => ({
    announceRoleChanged: vi.fn(),
}))

describe.skipIf(!hasPg || !hasRedis)('a privileged write against a revoked session', async () => {
    const { db, pool } = await import('#database/db.js')
    const { users, auditEvents } = await import('#database/schema.js')
    const { default: client, redisHealth } = (await import('#database/redis.js')) as unknown as {
        default: Redis
        redisHealth: { stop(): void }
    }
    const storage = await import('#vendor/utils/session/redis-session-storage.js')
    const { sessionPublicId } = await import('#vendor/utils/session/session-public-id.js')
    const { userRepository, totpFactorRepository, withTransaction } =
        await import('#app/repositories/index.js')
    const { roleAssignmentService } = await import('#app/services/user/role-assignment-service.js')
    const { sessionListService } = await import('#app/services/user/session-list-service.js')
    const { mfaResetService } = await import('./mfa-reset-service.js')
    const { loadMfaFactors } = await import('./mfa-account.js')
    const { appErrorToPayload } = await import('#app/services/shared/app-error-payload.js')
    const { underUserRowLock } = await import('#app/services/user/session-list-service.js')
    const { sessionHandler } = await import('#vendor/utils/session/session-handler.js')
    const { registerSessionDeletionLock, SessionDeletionDeferredError } =
        await import('#vendor/utils/session/session-deletion-lock.js')
    const { registerSessionTokenChecker } =
        await import('#vendor/utils/session/session-token-check.js')
    const { createResponseData } = await import('#vendor/utils/network/response-data.js')
    const { default: createContext } = await import('#vendor/utils/context/http-context.js')
    const { default: sessionConfig } = await import('#config/session.js')

    // The token rotation is not what these tests are about: every presented token is current.
    registerSessionTokenChecker(() => Promise.resolve('ok'))

    const redisAdmin = createTestRedis(PREFIX)
    const created: UserId[] = []

    beforeAll(async () => {
        await redisAdmin.connect()
        await client.connect()
    })
    afterEach(() => {
        vi.restoreAllMocks()
    })
    afterAll(async () => {
        for (const id of created) {
            await db.delete(auditEvents).where(eq(auditEvents.targetUserId, id))
            await db.delete(users).where(eq(users.id, id))
        }
        await cleanupTestRedis(redisAdmin)
        redisHealth.stop()
        client.disconnect(false)
        await redisAdmin.quit()
        await pool.end()
    })

    const insertUser = async (role: Role) => {
        const [row] = await db
            .insert(users)
            .values({
                name: 'privileged-revocation',
                email: `privileged-revocation-${crypto.randomUUID()}@example.test` as NormalizedEmail,
                emailVerifiedAt: new Date(),
                password: 'hash',
                role,
            })
            .returning()
        if (row === undefined) throw new Error('user not inserted')
        created.push(row.id)
        return row
    }
    const withTotp = (userId: UserId) =>
        withTransaction((tx) =>
            totpFactorRepository.replace(
                {
                    userId,
                    enrollmentId: crypto.randomUUID().slice(0, 32),
                    secretCiphertext: Buffer.from([1]),
                    keyId: 'k1',
                    lastUsedStep: 0n,
                    confirmedAt: new Date(),
                },
                tx,
            ),
        )

    /** A signed-in session of `user` stored in Redis, with its index member (feat-233). */
    const signIn = async (user: { id: UserId; sessionToken: string }) => {
        const id = crypto.randomUUID().replaceAll('-', '')
        const publicId = sessionPublicId(id)
        const now = Date.now()
        const info = {
            id,
            data: {
                userId: String(user.id),
                userToken: user.sessionToken,
                csrfToken: 'c'.repeat(43),
                device: {
                    publicId,
                    ip: '203.0.113.7',
                    userAgent: 'Mozilla/5.0',
                    method: 'password' as const,
                    signedInAt: new Date(now).toISOString(),
                },
            },
            createdAt: new Date(now).toISOString(),
        }
        await storage.createSignedInSession(info, user.sessionToken, publicId, now)
        return {
            info,
            publicId,
            /** What the controller passes: `context.session.isStored()`. */
            isStored: () => storage.sessionExists(id, user.sessionToken),
        }
    }

    /** One HTTP request of the session the cookie names, through the real session layer. */
    const requestWith = async (cookie: string | undefined) => {
        const responseData = createResponseData()
        const context = createContext(
            { method: 'post', headers: new Map(), cookies: new Map() } as never,
            responseData,
        )
        await sessionHandler(context, cookie, undefined)
        return { context, responseData }
    }

    /** A signed-in session made by `auth.login`, as a sign-in request makes it; its cookie. */
    const signInOverHttp = async (user: { id: UserId; sessionToken: string }) => {
        const { context, responseData } = await requestWith(undefined)
        await context.auth.login(String(user.id), user.sessionToken, { method: 'password' })
        const cookie = responseData.cookies.get(sessionConfig.cookieName)?.value
        if (cookie === undefined) throw new Error('no session cookie issued')
        return {
            cookie,
            /** `context.session.isStored()` of a request that presents the cookie. */
            isStored: async () => (await requestWith(cookie)).context.session.isStored(),
            /** POST /auth/logout of this session: `context.auth.logout()`. */
            logout: async () => (await requestWith(cookie)).context.auth.logout(),
        }
    }

    interface Newcomer {
        id: UserId
        sessionToken: string
    }
    /**
     * Р13: sign-ins in a request that presents `cookie`: each replaces that session. The password
     * sign-in (`auth.login`) and the activation of a second-step sign-in (`auth.activateLogin`,
     * after its Lua transition) both delete the previous record. Answer: whether it signed in.
     */
    const signIns = {
        'a password sign-in': async (cookie: string, user: Newcomer): Promise<boolean> => {
            const { context } = await requestWith(cookie)
            const device = await context.auth.login(String(user.id), user.sessionToken, {
                method: 'password',
            })
            return device !== null
        },
        'an MFA activation': async (cookie: string, user: Newcomer): Promise<boolean> => {
            const { context } = await requestWith(cookie)
            const plan = context.auth.planLogin(
                String(user.id),
                { method: 'password' },
                freshPassword(),
                user.sessionToken,
            )
            const completionId = crypto.randomUUID()
            const ticketKey = `mfa_ticket:${crypto.randomUUID()}`
            expect(await context.auth.prepareLogin(plan, completionId, 300)).toBe('created')
            await client.set(
                storage.sanitizeRedisKey(ticketKey),
                JSON.stringify({ completionId, state: 'completing' }),
                'EX',
                300,
            )
            return (await context.auth.activateLogin(plan, ticketKey, completionId)) === 'activated'
        },
    }

    const freshPassword = () => {
        const at = new Date().toISOString()
        return {
            v: 1 as const,
            amr: ['pwd' as const],
            aal: 1 as const,
            authenticatedAt: at,
            verified: { pwd: at },
        }
    }
    const actorOf = (admin: { id: UserId }) => ({
        ...testAdminActor(admin.id),
        role: 'admin' as const,
    })
    const payloadOf = (result: unknown) =>
        appErrorToPayload((result as { error: Parameters<typeof appErrorToPayload>[0] }).error)
    const roleOf = async (id: UserId) =>
        (await db.select({ role: users.role }).from(users).where(eq(users.id, id)))[0]?.role
    const roleEvents = (targetUserId: UserId) =>
        db
            .select()
            .from(auditEvents)
            .where(
                and(
                    eq(auditEvents.targetUserId, targetUserId),
                    eq(auditEvents.action, 'user.role.changed'),
                ),
            )

    /** Runs `pause` before every call of `method`, then the real method. */
    const holdBefore = <T extends object>(
        repository: T,
        method: keyof T & string,
        pause: () => Promise<void>,
    ): void => {
        const original = (repository[method] as (...args: unknown[]) => Promise<unknown>).bind(
            repository,
        )
        vi.spyOn(repository, method as never).mockImplementation((async (...args: unknown[]) => {
            await pause()
            return original(...args)
        }) as never)
    }

    type Admin = Awaited<ReturnType<typeof insertUser>>
    type SessionStored = (() => Promise<boolean>) | undefined

    const writes = {
        'role change': {
            target: () => insertUser('kb_editor'),
            run: (admin: Admin, sessionStored: SessionStored, targetId: UserId) =>
                roleAssignmentService.assign({
                    actor: actorOf(admin),
                    targetUserId: targetId,
                    role: 'user',
                    sessionAuth: freshPassword(),
                    presentedSessionToken: admin.sessionToken,
                    sessionStored,
                }),
            /** The write of the change, after the re-check under the lock. */
            hold: (pause: () => Promise<void>) => {
                holdBefore(userRepository, 'updateRole', pause)
            },
            unchanged: async (targetId: UserId) => {
                expect(await roleOf(targetId)).toBe('kb_editor')
                expect(await roleEvents(targetId)).toHaveLength(0)
            },
            written: async (targetId: UserId) => {
                expect(await roleOf(targetId)).toBe('user')
                expect(await roleEvents(targetId)).toHaveLength(1)
            },
        },
        'MFA reset': {
            target: async () => {
                const target = await insertUser('user')
                await withTotp(target.id)
                return target
            },
            run: (admin: Admin, sessionStored: SessionStored, targetId: UserId) =>
                mfaResetService.reset({
                    actor: actorOf(admin),
                    targetUserId: targetId,
                    reason: 'lost phone',
                    sessionAuth: freshPassword(),
                    presentedSessionToken: admin.sessionToken,
                    sessionStored,
                }),
            hold: (pause: () => Promise<void>) => {
                holdBefore(totpFactorRepository, 'deleteByUserId', pause)
            },
            unchanged: async (targetId: UserId) => {
                expect((await loadMfaFactors(targetId)).totp).toBeDefined()
            },
            written: async (targetId: UserId) => {
                expect((await loadMfaFactors(targetId)).totp).toBeUndefined()
            },
        },
    }

    describe.each(Object.entries(writes))('%s', (_, write) => {
        it('the session is ended while the write waits for its lock: 401 session_revoked, nothing written', async () => {
            // The target first: its id is the lower one, so the write waits on the target's row
            // (locked by the test) before it locks the admin's, and the revocation can go on.
            const target = await write.target()
            const admin = await insertUser('admin')
            const requesting = await signIn(admin)
            const other = await signIn(admin)

            let pending: ReturnType<typeof write.run> | undefined
            await db.transaction(async (tx) => {
                await tx.execute(sql`SELECT id FROM users WHERE id = ${target.id} FOR UPDATE`)
                pending = write.run(admin, requesting.isStored, target.id)
                await waitForLockWaiters((q) => pool.query(q), 1)
                // From the other session: end the one that sent the write.
                const revoked = await sessionListService.revoke({
                    userId: String(admin.id),
                    current: other.info,
                    publicId: requesting.publicId,
                    sessionStored: other.isStored,
                })
                expect(revoked.status).toBe('ok')
            })
            if (pending === undefined) throw new Error('not started')

            const result = await pending
            expect(payloadOf(result)).toMatchObject({
                code: 'unauthorized',
                reason: 'session_revoked',
            })
            await write.unchanged(target.id)
            // The token did not rotate: the record is what the write saw gone.
            expect(await userRepository.findSessionToken(admin.id)).toBe(admin.sessionToken)
        })

        it('a revocation during the write waits for its commit', async () => {
            const target = await write.target()
            const admin = await insertUser('admin')
            const requesting = await signIn(admin)
            const other = await signIn(admin)

            // Hold the write after the re-check under the admin's row lock.
            let reached: () => void = () => undefined
            const atWrite = new Promise<void>((resolve) => {
                reached = resolve
            })
            let release: () => void = () => undefined
            const gate = new Promise<void>((resolve) => {
                release = resolve
            })
            write.hold(async () => {
                reached()
                await gate
            })

            const pending = write.run(admin, requesting.isStored, target.id)
            await atWrite
            let revocationDone = false
            const revocation = sessionListService
                .revoke({
                    userId: String(admin.id),
                    current: other.info,
                    publicId: requesting.publicId,
                    sessionStored: other.isStored,
                })
                .finally(() => {
                    revocationDone = true
                })
            await waitForLockWaiters((q) => pool.query(q), 1)
            expect(revocationDone).toBe(false)
            expect(await requesting.isStored()).toBe(true)

            release()
            expect((await pending).status).toBe('ok')
            expect((await revocation).status).toBe('ok')
            expect(await requesting.isStored()).toBe(false)
            await write.written(target.id)
        })

        describe('a plain logout of the session that sent the write', () => {
            beforeAll(() => {
                registerSessionDeletionLock(underUserRowLock)
            })
            afterAll(() => {
                registerSessionDeletionLock(null)
            })

            it('a logout that finishes first: 401 session_revoked, nothing written', async () => {
                // As above: the write waits on the target's row (locked by the test) before it
                // locks the admin's, and the logout, which locks the admin's, goes on.
                const target = await write.target()
                const admin = await insertUser('admin')
                const requesting = await signInOverHttp(admin)

                let pending: ReturnType<typeof write.run> | undefined
                await db.transaction(async (tx) => {
                    await tx.execute(sql`SELECT id FROM users WHERE id = ${target.id} FOR UPDATE`)
                    pending = write.run(admin, requesting.isStored, target.id)
                    await waitForLockWaiters((q) => pool.query(q), 1)
                    expect(await requesting.logout()).toBe(true)
                })
                if (pending === undefined) throw new Error('not started')

                expect(payloadOf(await pending)).toMatchObject({
                    code: 'unauthorized',
                    reason: 'session_revoked',
                })
                await write.unchanged(target.id)
                expect(await requesting.isStored()).toBe(false)
                expect(await userRepository.findSessionToken(admin.id)).toBe(admin.sessionToken)
            })

            it('a logout during the write (after its session check) waits for its commit', async () => {
                const target = await write.target()
                const admin = await insertUser('admin')
                const requesting = await signInOverHttp(admin)

                let reached: () => void = () => undefined
                const atWrite = new Promise<void>((resolve) => {
                    reached = resolve
                })
                let release: () => void = () => undefined
                const gate = new Promise<void>((resolve) => {
                    release = resolve
                })
                write.hold(async () => {
                    reached()
                    await gate
                })

                const pending = write.run(admin, requesting.isStored, target.id)
                await atWrite
                let logoutDone = false
                const logout = requesting.logout().finally(() => {
                    logoutDone = true
                })
                await waitForLockWaiters((q) => pool.query(q), 1)
                expect(logoutDone).toBe(false)
                expect(await requesting.isStored()).toBe(true)

                release()
                expect((await pending).status).toBe('ok')
                expect(await logout).toBe(true)
                expect(await requesting.isStored()).toBe(false)
                await write.written(target.id)
            })
        })

        describe.each(Object.entries(signIns))(
            '%s that replaces the session that sent the write',
            (_label, signInOver) => {
                beforeAll(() => {
                    registerSessionDeletionLock(underUserRowLock)
                })
                afterAll(() => {
                    registerSessionDeletionLock(null)
                })

                it('a sign-in that finishes first: 401 session_revoked, nothing written', async () => {
                    const target = await write.target()
                    const admin = await insertUser('admin')
                    const newcomer = await insertUser('user')
                    const requesting = await signInOverHttp(admin)

                    let pending: ReturnType<typeof write.run> | undefined
                    await db.transaction(async (tx) => {
                        await tx.execute(
                            sql`SELECT id FROM users WHERE id = ${target.id} FOR UPDATE`,
                        )
                        pending = write.run(admin, requesting.isStored, target.id)
                        await waitForLockWaiters((q) => pool.query(q), 1)
                        expect(await signInOver(requesting.cookie, newcomer)).toBe(true)
                    })
                    if (pending === undefined) throw new Error('not started')

                    expect(payloadOf(await pending)).toMatchObject({
                        code: 'unauthorized',
                        reason: 'session_revoked',
                    })
                    await write.unchanged(target.id)
                    expect(await requesting.isStored()).toBe(false)
                })

                it('a sign-in during the write (after its session check) waits for its commit', async () => {
                    const target = await write.target()
                    const admin = await insertUser('admin')
                    // Another account: the lock is the PREVIOUS session's user's row.
                    const newcomer = await insertUser('user')
                    const requesting = await signInOverHttp(admin)

                    let reached: () => void = () => undefined
                    const atWrite = new Promise<void>((resolve) => {
                        reached = resolve
                    })
                    let release: () => void = () => undefined
                    const gate = new Promise<void>((resolve) => {
                        release = resolve
                    })
                    write.hold(async () => {
                        reached()
                        await gate
                    })

                    const pending = write.run(admin, requesting.isStored, target.id)
                    await atWrite
                    let signInDone = false
                    const signIn = signInOver(requesting.cookie, newcomer).finally(() => {
                        signInDone = true
                    })
                    await waitForLockWaiters((q) => pool.query(q), 1)
                    expect(signInDone).toBe(false)
                    expect(await requesting.isStored()).toBe(true)

                    release()
                    expect((await pending).status).toBe('ok')
                    expect(await signIn).toBe(true)
                    expect(await requesting.isStored()).toBe(false)
                    await write.written(target.id)
                })
            },
        )

        it('a user actor without the session check is refused: 401 session_revoked', async () => {
            const target = await write.target()
            const admin = await insertUser('admin')
            await signIn(admin)
            const result = await write.run(admin, undefined, target.id)
            expect(payloadOf(result)).toMatchObject({ reason: 'session_revoked' })
            await write.unchanged(target.id)
        })
    })

    describe('a logout and the row lock hook', () => {
        afterEach(() => {
            registerSessionDeletionLock(null)
        })

        it('without the hook (tests, the CLI) the record is deleted as before', async () => {
            registerSessionDeletionLock(null)
            const admin = await insertUser('admin')
            const session = await signInOverHttp(admin)
            expect(await session.logout()).toBe(true)
            expect(await session.isStored()).toBe(false)
        })

        it('a lock that cannot be taken (PostgreSQL down) does not keep the logout', async () => {
            // A write commits through the same database: it cannot commit either.
            registerSessionDeletionLock(() =>
                Promise.reject(
                    Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
                ),
            )
            const admin = await insertUser('admin')
            const session = await signInOverHttp(admin)
            expect(await session.logout()).toBe(true)
            expect(await session.isStored()).toBe(false)
        })

        it('a failure not known to be an outage keeps the record: the logout is refused', async () => {
            registerSessionDeletionLock(() => Promise.reject(new Error('Query read timeout')))
            const admin = await insertUser('admin')
            const session = await signInOverHttp(admin)
            await expect(session.logout()).rejects.toBeInstanceOf(SessionDeletionDeferredError)
            expect(await session.isStored()).toBe(true)
        })

        it('an anonymous session replaced by a sign-in takes no lock', async () => {
            const lock = vi.fn(() => Promise.reject(new Error('not expected')))
            registerSessionDeletionLock(lock)
            const user = await insertUser('user')
            const session = await signInOverHttp(user)
            expect(await session.isStored()).toBe(true)
            expect(lock).not.toHaveBeenCalled()
        })

        it('a COMMIT that fails after the deletion does not fail the logout', async () => {
            registerSessionDeletionLock(async (_userId, work) => {
                await work()
                throw new Error('connection lost at COMMIT')
            })
            const admin = await insertUser('admin')
            const session = await signInOverHttp(admin)
            expect(await session.logout()).toBe(true)
            expect(await session.isStored()).toBe(false)
        })
    })
})
