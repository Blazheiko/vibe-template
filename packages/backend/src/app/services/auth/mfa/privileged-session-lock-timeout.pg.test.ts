import type { Redis } from 'ioredis'
import { and, eq } from 'drizzle-orm'
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

// docs/plan/passkeys-mfa-plan.md (Р13), on a real PostgreSQL and a real Redis with a short
// statement_timeout: a logout, or a sign-in that replaces a signed-in session, deletes the record
// under its user's row lock. When a role change sent from that session holds the row past the
// wait, the wait is repeated; past every wait the record stays (never deleted without the lock)
// and the request answers retryable: the logout 503 `logout_retry`, the sign-in throws before it
// issues anything. The write commits and the repeated request ends the session.

const { PREFIX } = vi.hoisted(() => {
    process.env['APP_KEY'] ??= 'k'.repeat(16) + '3f9a1c7e5b2d4f60'
    process.env['AUTH_OTP_HMAC_KEY'] ??= 'o'.repeat(32)
    // Every statement of the pool, the lock waits too, is cut after this.
    process.env['DB_QUERY_TIMEOUT_MS'] = '400'
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

describe.skipIf(!hasPg || !hasRedis)('a session deletion whose lock wait is cut', async () => {
    const { db, pool } = await import('#database/db.js')
    const { users, auditEvents } = await import('#database/schema.js')
    const { default: client, redisHealth } = (await import('#database/redis.js')) as unknown as {
        default: Redis
        redisHealth: { stop(): void }
    }
    const storage = await import('#vendor/utils/session/redis-session-storage.js')
    const { userRepository } = await import('#app/repositories/index.js')
    const { roleAssignmentService } = await import('#app/services/user/role-assignment-service.js')
    const { underUserRowLock } = await import('#app/services/user/session-list-service.js')
    const { authService } = await import('#app/services/auth/auth-service.js')
    const { appErrorToPayload } = await import('#app/services/shared/app-error-payload.js')
    const { sessionHandler } = await import('#vendor/utils/session/session-handler.js')
    const { registerSessionDeletionLock, SessionDeletionDeferredError, LOCK_WAIT_ATTEMPTS } =
        await import('#vendor/utils/session/session-deletion-lock.js')
    const { registerSessionTokenChecker } =
        await import('#vendor/utils/session/session-token-check.js')
    const { createResponseData } = await import('#vendor/utils/network/response-data.js')
    const { default: createContext } = await import('#vendor/utils/context/http-context.js')
    const { default: sessionConfig } = await import('#config/session.js')

    registerSessionTokenChecker(() => Promise.resolve('ok'))

    const redisAdmin = createTestRedis(PREFIX)
    const created: bigint[] = []
    /** Lock attempts of the current test; `onAttempt` sees each one before it waits. */
    let attempts = 0
    let onAttempt: (n: number) => void = () => undefined

    beforeAll(async () => {
        await redisAdmin.connect()
        await client.connect()
        registerSessionDeletionLock((userId, work) => {
            attempts += 1
            onAttempt(attempts)
            return underUserRowLock(userId, work)
        })
    })
    afterEach(() => {
        vi.restoreAllMocks()
        attempts = 0
        onAttempt = () => undefined
    })
    afterAll(async () => {
        registerSessionDeletionLock(null)
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
                name: 'lock-timeout',
                email: `lock-timeout-${crypto.randomUUID()}@example.test`,
                emailVerifiedAt: new Date(),
                password: 'hash',
                role,
            })
            .returning()
        if (row === undefined) throw new Error('user not inserted')
        created.push(row.id)
        return row
    }

    const requestWith = async (cookie: string | undefined) => {
        const responseData = createResponseData()
        const context = createContext(
            { method: 'post', headers: new Map(), cookies: new Map() } as never,
            responseData,
        )
        await sessionHandler(context, cookie, undefined)
        return { context, responseData }
    }

    const signInOverHttp = async (user: { id: bigint; sessionToken: string }) => {
        const { context, responseData } = await requestWith(undefined)
        await context.auth.login(String(user.id), user.sessionToken, { method: 'password' })
        const cookie = responseData.cookies.get(sessionConfig.cookieName)?.value
        if (cookie === undefined) throw new Error('no session cookie issued')
        return {
            cookie,
            isStored: async () => (await requestWith(cookie)).context.session.isStored(),
            /** POST /auth/logout of this session, as the controller runs it. */
            logout: async () => {
                const { context } = await requestWith(cookie)
                return authService.logout(context.auth, context.session)
            },
        }
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
    const payloadOf = (result: unknown) =>
        appErrorToPayload((result as { error: Parameters<typeof appErrorToPayload>[0] }).error)

    /** A role change of `target` sent from the admin's session, held after its session check. */
    const heldRoleChange = async (
        admin: Awaited<ReturnType<typeof insertUser>>,
        sessionStored: () => Promise<boolean>,
    ) => {
        const target = await insertUser('kb_editor')
        let reached: () => void = () => undefined
        const atWrite = new Promise<void>((resolve) => {
            reached = resolve
        })
        let release: () => void = () => undefined
        const gate = new Promise<void>((resolve) => {
            release = resolve
        })
        const original = userRepository.updateRole.bind(userRepository)
        vi.spyOn(userRepository, 'updateRole').mockImplementation(
            async (...args: Parameters<typeof userRepository.updateRole>) => {
                reached()
                await gate
                return original(...args)
            },
        )
        const pending = roleAssignmentService.assign({
            actor: { ...testAdminActor(admin.id), role: 'admin' as const },
            targetUserId: target.id,
            role: 'user',
            sessionAuth: freshPassword(),
            presentedSessionToken: admin.sessionToken,
            sessionStored,
        })
        await atWrite
        const written = async () => {
            const [row] = await db
                .select({ role: users.role })
                .from(users)
                .where(eq(users.id, target.id))
            expect(row?.role).toBe('user')
            const events = await db
                .select()
                .from(auditEvents)
                .where(
                    and(
                        eq(auditEvents.targetUserId, target.id),
                        eq(auditEvents.action, 'user.role.changed'),
                    ),
                )
            expect(events).toHaveLength(1)
        }
        return { pending, release, written }
    }

    it('a logout whose first wait is cut waits again and ends after the commit', async () => {
        const admin = await insertUser('admin')
        const session = await signInOverHttp(admin)
        const write = await heldRoleChange(admin, session.isStored)

        const secondAttempt = new Promise<void>((resolve) => {
            onAttempt = (n) => {
                if (n === 2) resolve()
            }
        })
        const logout = session.logout()
        await secondAttempt
        await waitForLockWaiters((q) => pool.query(q), 1)
        expect(await session.isStored()).toBe(true)

        write.release()
        expect((await write.pending).status).toBe('ok')
        expect((await logout).status).toBe('ok')
        expect(attempts).toBe(2)
        expect(await session.isStored()).toBe(false)
        await write.written()
    })

    it('a logout held past every wait: 503 logout_retry, the session stays; repeated after the commit it ends', async () => {
        const admin = await insertUser('admin')
        const session = await signInOverHttp(admin)
        const write = await heldRoleChange(admin, session.isStored)

        const refused = await session.logout()
        expect(payloadOf(refused)).toMatchObject({
            code: 'service_unavailable',
            reason: 'logout_retry',
        })
        expect(attempts).toBe(LOCK_WAIT_ATTEMPTS)
        // Never deleted without the lock: the write that checked it still commits consistently.
        expect(await session.isStored()).toBe(true)

        write.release()
        expect((await write.pending).status).toBe('ok')
        await write.written()

        expect((await session.logout()).status).toBe('ok')
        expect(await session.isStored()).toBe(false)
    })

    it('a password sign-in over the session held past every wait: nothing new issued, the previous session stays', async () => {
        const admin = await insertUser('admin')
        const newcomer = await insertUser('user')
        const session = await signInOverHttp(admin)
        const write = await heldRoleChange(admin, session.isStored)

        const { context, responseData } = await requestWith(session.cookie)
        const cookieBefore = responseData.cookies.get(sessionConfig.cookieName)?.value
        await expect(
            context.auth.login(String(newcomer.id), newcomer.sessionToken, { method: 'password' }),
        ).rejects.toBeInstanceOf(SessionDeletionDeferredError)
        expect(responseData.cookies.get(sessionConfig.cookieName)?.value).toBe(cookieBefore)
        expect(await session.isStored()).toBe(true)
        expect(
            (await storage.listSessions(newcomer.sessionToken, { after: null })).sessions,
        ).toHaveLength(0)

        write.release()
        expect((await write.pending).status).toBe('ok')
        await write.written()
    })

    it('an MFA activation over the session held past every wait: the activation stays done, the repeat deletes the previous record', async () => {
        const admin = await insertUser('admin')
        const newcomer = await insertUser('user')
        const session = await signInOverHttp(admin)
        const write = await heldRoleChange(admin, session.isStored)

        const first = await requestWith(session.cookie)
        const plan = first.context.auth.planLogin(
            String(newcomer.id),
            { method: 'password' },
            freshPassword(),
            newcomer.sessionToken,
        )
        const completionId = crypto.randomUUID()
        const ticketKey = `mfa_ticket:${crypto.randomUUID()}`
        expect(await first.context.auth.prepareLogin(plan, completionId, 300)).toBe('created')
        await client.set(
            storage.sanitizeRedisKey(ticketKey),
            JSON.stringify({ completionId, state: 'completing' }),
            'EX',
            300,
        )

        // mfa-sign-in answers this 503 `mfa_completion_pending`: the same request finishes it.
        await expect(
            first.context.auth.activateLogin(plan, ticketKey, completionId),
        ).rejects.toBeInstanceOf(SessionDeletionDeferredError)
        expect(await session.isStored()).toBe(true)
        // The one transition happened: the ticket is activated, the new record exists.
        const ticket = JSON.parse((await client.get(storage.sanitizeRedisKey(ticketKey))) ?? '{}')
        expect(ticket.state).toBe('activated')
        expect(await storage.sessionExists(plan.sessionId, newcomer.sessionToken)).toBe(true)

        write.release()
        expect((await write.pending).status).toBe('ok')
        await write.written()

        const repeat = await requestWith(session.cookie)
        expect(await repeat.context.auth.activateLogin(plan, ticketKey, completionId)).toBe(
            'already',
        )
        expect(await session.isStored()).toBe(false)
        expect(await storage.sessionExists(plan.sessionId, newcomer.sessionToken)).toBe(true)
    })
})
