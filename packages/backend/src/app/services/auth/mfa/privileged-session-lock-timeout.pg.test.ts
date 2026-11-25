import type { Redis } from 'ioredis'
import type { UserId } from '#app/domain/ids.js'
import type * as SessionIndex from '#vendor/utils/session/session-index.js'
import type * as SessionStorage from '#vendor/utils/session/redis-session-storage.js'
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
const effects = vi.hoisted(() => ({
    closeUserConnections: vi.fn(() => 0),
    notifyNewSignIn: vi.fn(),
    announceMfaChange: vi.fn(),
}))
vi.mock('#app/services/auth/ws-session-revocation.js', () => ({
    wsSessionRevocation: { closeUserConnections: effects.closeUserConnections },
}))
vi.mock('#app/services/auth/new-sign-in-notice.js', async (importActual) => ({
    ...(await importActual<Record<string, unknown>>()),
    notifyNewSignIn: effects.notifyNewSignIn,
}))
vi.mock('#app/services/auth/mfa/mfa-notice.js', async (importActual) => ({
    ...(await importActual<Record<string, unknown>>()),
    announceMfaChange: effects.announceMfaChange,
}))
vi.mock('#app/services/communication/role-change-announcer.js', () => ({
    announceRoleChanged: vi.fn(),
}))
// Injected Redis failures of the activation's tail (Р4, Р8): the effects claim fails before it
// runs (`throw`) or after it ran, its answer lost (`lost`); the recovery cleanup stops part-way.
// All of these run before the previous session is deleted (the last step that can fail).
const failures = vi.hoisted((): { claim: 'none' | 'throw' | 'lost'; cleanup: boolean } => ({
    claim: 'none',
    cleanup: false,
}))
vi.mock('#vendor/utils/session/session-index.js', async (importActual) => {
    const actual = await importActual<typeof SessionIndex>()
    // What withRedis throws for an unreachable Redis (ADR 0004: answered as a repeatable failure).
    const { RedisUnavailableError } =
        await import('#vendor/utils/network/errors/redis-unavailable-error.js')
    return {
        ...actual,
        claimActivationEffects: async (
            ...args: Parameters<typeof actual.claimActivationEffects>
        ) => {
            const mode = failures.claim
            failures.claim = 'none'
            if (mode === 'throw') throw new RedisUnavailableError('Redis down (claim)')
            const claimed = await actual.claimActivationEffects(...args)
            if (mode === 'lost') throw new RedisUnavailableError('Redis answer lost (claim)')
            return claimed
        },
    }
})
vi.mock('#vendor/utils/session/redis-session-storage.js', async (importActual) => {
    const actual = await importActual<typeof SessionStorage>()
    return {
        ...actual,
        destroyAllSessions: (...args: Parameters<typeof actual.destroyAllSessions>) => {
            if (failures.cleanup) {
                failures.cleanup = false
                return Promise.resolve({ deleted: 0, complete: false })
            }
            return actual.destroyAllSessions(...args)
        },
    }
})

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
    const { completeSecondStep } = await import('#app/services/auth/mfa/mfa-sign-in.js')
    const { mfaBinding, mfaTicketStore, newTicketId } =
        await import('#app/services/auth/mfa/mfa-ticket.js')
    const { currentTransactionId, withTransaction } = await import('#app/repositories/index.js')
    const { mfaBindCookieName, mfaTicketCookieName } =
        await import('#vendor/utils/session/request-session.js')
    const BIND_VALUE = 'bind-value-of-this-browser'
    const { testRequest } = await import('../../../../test-support/audit-actor.js')

    registerSessionTokenChecker(() => Promise.resolve('ok'))

    const redisAdmin = createTestRedis(PREFIX)
    const created: UserId[] = []
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
        effects.closeUserConnections.mockClear()
        effects.notifyNewSignIn.mockClear()
        effects.announceMfaChange.mockClear()
        attempts = 0
        onAttempt = () => undefined
        failures.claim = 'none'
        failures.cleanup = false
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

    const requestWith = async (cookie: string | undefined, ticketCookie?: string) => {
        const responseData = createResponseData()
        const cookies = new Map<string, string>()
        if (ticketCookie !== undefined) {
            cookies.set(mfaTicketCookieName(), ticketCookie)
            // feat-257: the ticket's binding cookie travels with it.
            cookies.set(mfaBindCookieName(), BIND_VALUE)
        }
        const context = createContext(
            { method: 'post', headers: new Map(), cookies } as never,
            responseData,
        )
        await sessionHandler(context, cookie, undefined)
        return { context, responseData }
    }

    const signInOverHttp = async (user: { id: UserId; sessionToken: string }) => {
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

    /** Kills the backend of the one lock wait running now (the logout's lock connection). */
    const terminateLockWaiter = async () => {
        await waitForLockWaiters((q) => pool.query(q), 1)
        const { rows } = await pool.query<{ pid: number }>(
            `SELECT pid FROM pg_stat_activity
             WHERE datname = current_database() AND wait_event_type = 'Lock'`,
        )
        expect(rows).toHaveLength(1)
        await pool.query('SELECT pg_terminate_backend($1)', [rows[0]?.pid])
    }

    it('the lock connection of a logout killed (pg_terminate_backend): asked again on a new one, ends after the commit', async () => {
        const admin = await insertUser('admin')
        const session = await signInOverHttp(admin)
        const write = await heldRoleChange(admin, session.isStored)

        const secondAttempt = new Promise<void>((resolve) => {
            onAttempt = (n) => {
                if (n === 2) resolve()
            }
        })
        const logout = session.logout()
        await terminateLockWaiter()
        // A single connection broke, the pool still answers: the record is not deleted without
        // the lock while the role change that checked it is uncommitted.
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

    it('the lock connection of a logout killed and the write still held: 503 logout_retry, the session stays', async () => {
        const admin = await insertUser('admin')
        const session = await signInOverHttp(admin)
        const write = await heldRoleChange(admin, session.isStored)

        const logout = session.logout()
        await terminateLockWaiter()
        const refused = await logout
        expect(payloadOf(refused)).toMatchObject({
            code: 'service_unavailable',
            reason: 'logout_retry',
        })
        expect(attempts).toBe(LOCK_WAIT_ATTEMPTS)
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

    /**
     * A second step of `newcomer` confirmed in the browser of `cookie`: its transaction committed,
     * the ticket `completing`, the session pending. `continue` is POST /auth/mfa/verify
     * `{ method: 'continue' }` of that browser, as the controller runs it.
     */
    const confirmedSecondStep = async (
        cookie: string,
        newcomer: Awaited<ReturnType<typeof insertUser>>,
        options: { recovery?: { userTokenAtStart: string } } = {},
    ) => {
        const { context } = await requestWith(cookie)
        const at = new Date().toISOString()
        const auth =
            options.recovery === undefined
                ? {
                      v: 1 as const,
                      amr: ['pwd' as const, 'otp' as const],
                      aal: 2 as const,
                      authenticatedAt: at,
                      verified: { pwd: at, otp: at },
                  }
                : {
                      v: 1 as const,
                      amr: ['pwd' as const, 'recovery' as const],
                      aal: 1 as const,
                      authenticatedAt: at,
                      verified: { pwd: at },
                      recovery: {
                          startedAt: at,
                          expiresAt: new Date(Date.now() + 600_000).toISOString(),
                      },
                  }
        const plan = context.auth.planLogin(
            String(newcomer.id),
            { method: 'password' },
            auth,
            newcomer.sessionToken,
        )
        const completionId = crypto.randomUUID()
        expect(await context.auth.prepareLogin(plan, completionId, 300)).toBe('created')
        const xid = await withTransaction((tx) => currentTransactionId(tx))
        const ticketId = newTicketId()
        await mfaTicketStore.create(
            ticketId,
            {
                v: 1,
                state: 'completing',
                userId: String(newcomer.id),
                userTokenAtStart: options.recovery?.userTokenAtStart ?? newcomer.sessionToken,
                binding: mfaBinding(BIND_VALUE),
                origin: { method: 'password' },
                firstFactor: 'pwd',
                failures: 0,
                reservations: [],
                settled: [],
                completionId,
                xid,
                plan,
            },
            300,
        )
        let lastResponse: ReturnType<typeof createResponseData> | undefined
        return {
            plan,
            ticket: () => mfaTicketStore.read(ticketId),
            continue: async () => {
                const { context, responseData } = await requestWith(cookie, ticketId)
                lastResponse = responseData
                return completeSecondStep(context, { method: 'continue' }, testRequest())
            },
            /** Whether the answer of the last `continue` carried the new session's cookie. */
            issuedNewSession: () => {
                const value = lastResponse?.cookies.get(sessionConfig.cookieName)?.value ?? ''
                return Buffer.from(value, 'base64').toString('utf8').includes(plan.sessionId)
            },
        }
    }

    describe('the effects of a second-step sign-in (Р4): once, before the replacement', () => {
        it('a replacement held past every wait: the notice is sent once, the previous session stays; the repeat replaces it and sends nothing', async () => {
            const admin = await insertUser('admin')
            const newcomer = await insertUser('user')
            const session = await signInOverHttp(admin)
            const write = await heldRoleChange(admin, session.isStored)
            const step = await confirmedSecondStep(session.cookie, newcomer)

            const pending = await step.continue()
            expect(payloadOf(pending)).toMatchObject({ reason: 'mfa_completion_pending' })
            expect(step.issuedNewSession()).toBe(false)
            // The claim ran before the deletion that was deferred: the effects are done.
            expect(effects.notifyNewSignIn).toHaveBeenCalledTimes(1)
            expect(effects.notifyNewSignIn).toHaveBeenCalledWith(newcomer.id, step.plan.device, {
                mail: true,
            })
            expect(await step.ticket()).toMatchObject({ state: 'activated', effects: 'done' })
            // Nothing was deleted without the lock: the browser's session is still there.
            expect(await session.isStored()).toBe(true)

            write.release()
            expect((await write.pending).status).toBe('ok')
            await write.written()

            // The repeat finds the activation done (`already`) and replaces the session now.
            expect((await step.continue()).status).toBe('ok')
            expect(step.issuedNewSession()).toBe(true)
            expect(await session.isStored()).toBe(false)
            expect(effects.notifyNewSignIn).toHaveBeenCalledTimes(1)
            // Not a recovery sign-in: nothing else ends.
            expect(effects.announceMfaChange).not.toHaveBeenCalled()
            expect(effects.closeUserConnections).not.toHaveBeenCalled()
        })

        it('a recovery sign-in whose replacement was held: the rotated token is cleaned up and announced once; the repeat replaces the session', async () => {
            const admin = await insertUser('admin')
            const newcomer = await insertUser('user')
            // The sessions of the token the recovery sign-in rotated away.
            const rotatedToken = crypto.randomUUID().replaceAll('-', '').slice(0, 24)
            const stale = await signInOverHttp({ id: newcomer.id, sessionToken: rotatedToken })
            expect(await stale.isStored()).toBe(true)
            const session = await signInOverHttp(admin)
            const write = await heldRoleChange(admin, session.isStored)
            const step = await confirmedSecondStep(session.cookie, newcomer, {
                recovery: { userTokenAtStart: rotatedToken },
            })

            expect(payloadOf(await step.continue())).toMatchObject({
                reason: 'mfa_completion_pending',
            })
            expect(effects.closeUserConnections).toHaveBeenCalledTimes(1)
            expect(effects.closeUserConnections).toHaveBeenCalledWith(String(newcomer.id), {
                exceptSessionId: step.plan.sessionId,
                userToken: rotatedToken,
            })
            expect(await stale.isStored()).toBe(false)
            expect(effects.notifyNewSignIn).toHaveBeenCalledTimes(1)
            expect(effects.announceMfaChange).toHaveBeenCalledTimes(1)
            expect(effects.announceMfaChange).toHaveBeenCalledWith(
                newcomer.id,
                'recovery_code_used',
            )
            expect(await session.isStored()).toBe(true)

            write.release()
            expect((await write.pending).status).toBe('ok')
            expect((await step.continue()).status).toBe('ok')
            expect(await session.isStored()).toBe(false)
            // The cleanup runs again (idempotent), the effects do not.
            expect(effects.closeUserConnections).toHaveBeenCalledTimes(2)
            expect(effects.notifyNewSignIn).toHaveBeenCalledTimes(1)
            expect(effects.announceMfaChange).toHaveBeenCalledTimes(1)
            expect(
                (await storage.listSessions(rotatedToken, { after: null })).sessions,
            ).toHaveLength(0)
        })

        it('an activation without contention sends the notice once; a lost answer repeated sends none', async () => {
            const admin = await insertUser('admin')
            const newcomer = await insertUser('user')
            const session = await signInOverHttp(admin)
            const step = await confirmedSecondStep(session.cookie, newcomer)

            expect((await step.continue()).status).toBe('ok')
            expect(effects.notifyNewSignIn).toHaveBeenCalledTimes(1)
            expect(await step.ticket()).toMatchObject({ state: 'activated', effects: 'done' })
            // The answer was lost: the browser repeats with the cookie it still has.
            expect((await step.continue()).status).toBe('ok')
            expect(effects.notifyNewSignIn).toHaveBeenCalledTimes(1)
        })
    })

    describe('a Redis failure before the replacement (Р4, Р8): retried, never lost or doubled', () => {
        /** A recovery sign-in of `newcomer` and a stored session of the token it rotated away. */
        const recoverySetup = async () => {
            const admin = await insertUser('admin')
            const newcomer = await insertUser('user')
            const rotatedToken = crypto.randomUUID().replaceAll('-', '').slice(0, 24)
            const stale = await signInOverHttp({ id: newcomer.id, sessionToken: rotatedToken })
            expect(await stale.isStored()).toBe(true)
            const session = await signInOverHttp(admin)
            const step = await confirmedSecondStep(session.cookie, newcomer, {
                recovery: { userTokenAtStart: rotatedToken },
            })
            return { newcomer, rotatedToken, stale, session, step }
        }

        it('a claim that fails: mfa_completion_pending without the cookie; the repeat sends the notice once and signs in', async () => {
            const admin = await insertUser('admin')
            const newcomer = await insertUser('user')
            const session = await signInOverHttp(admin)
            const step = await confirmedSecondStep(session.cookie, newcomer)

            failures.claim = 'throw'
            expect(payloadOf(await step.continue())).toMatchObject({
                reason: 'mfa_completion_pending',
            })
            expect(step.issuedNewSession()).toBe(false)
            expect(effects.notifyNewSignIn).not.toHaveBeenCalled()
            // Not retired: the effects wait for the repeat.
            expect(await step.ticket()).toMatchObject({ state: 'activated', effects: 'pending' })
            // The browser's session is still there for the repeat (its CSRF token, the binding).
            expect(await session.isStored()).toBe(true)

            expect((await step.continue()).status).toBe('ok')
            expect(step.issuedNewSession()).toBe(true)
            expect(effects.notifyNewSignIn).toHaveBeenCalledTimes(1)
            expect(await step.ticket()).toMatchObject({ state: 'activated', effects: 'done' })
            expect(await session.isStored()).toBe(false)

            // A later repeat (a lost answer) sends nothing again.
            expect((await step.continue()).status).toBe('ok')
            expect(effects.notifyNewSignIn).toHaveBeenCalledTimes(1)
        })

        it('a claim whose answer was lost: the repeat signs in and sends no notice twice', async () => {
            const admin = await insertUser('admin')
            const newcomer = await insertUser('user')
            const session = await signInOverHttp(admin)
            const step = await confirmedSecondStep(session.cookie, newcomer)

            failures.claim = 'lost'
            expect(payloadOf(await step.continue())).toMatchObject({
                reason: 'mfa_completion_pending',
            })
            expect(step.issuedNewSession()).toBe(false)
            // The claim ran: the effects are `done`, at most once means none now.
            expect(await step.ticket()).toMatchObject({ state: 'activated', effects: 'done' })
            expect(await session.isStored()).toBe(true)

            expect((await step.continue()).status).toBe('ok')
            expect(step.issuedNewSession()).toBe(true)
            expect(effects.notifyNewSignIn).not.toHaveBeenCalled()
        })

        it('a recovery cleanup that fails: mfa_completion_pending; the repeat closes the sockets, ends the rotated sessions, signs in', async () => {
            const { newcomer, rotatedToken, stale, session, step } = await recoverySetup()

            failures.cleanup = true
            expect(payloadOf(await step.continue())).toMatchObject({
                reason: 'mfa_completion_pending',
            })
            expect(step.issuedNewSession()).toBe(false)
            expect(await stale.isStored()).toBe(true)
            expect(effects.notifyNewSignIn).not.toHaveBeenCalled()
            expect(effects.announceMfaChange).not.toHaveBeenCalled()
            expect(await step.ticket()).toMatchObject({ state: 'activated', effects: 'pending' })
            expect(await session.isStored()).toBe(true)

            expect((await step.continue()).status).toBe('ok')
            expect(step.issuedNewSession()).toBe(true)
            expect(await stale.isStored()).toBe(false)
            expect(
                (await storage.listSessions(rotatedToken, { after: null })).sessions,
            ).toHaveLength(0)
            for (const call of effects.closeUserConnections.mock.calls as unknown[][]) {
                expect(call).toEqual([
                    String(newcomer.id),
                    { exceptSessionId: step.plan.sessionId, userToken: rotatedToken },
                ])
            }
            expect(effects.closeUserConnections).toHaveBeenCalledTimes(2)
            expect(effects.notifyNewSignIn).toHaveBeenCalledTimes(1)
            expect(effects.announceMfaChange).toHaveBeenCalledTimes(1)
            expect(effects.announceMfaChange).toHaveBeenCalledWith(
                newcomer.id,
                'recovery_code_used',
            )
        })

        it('the cleanup spares the browser’s own session even when it carries the rotated token: a failed claim leaves it for the repeat', async () => {
            const newcomer = await insertUser('user')
            const rotatedToken = crypto.randomUUID().replaceAll('-', '').slice(0, 24)
            const stale = await signInOverHttp({ id: newcomer.id, sessionToken: rotatedToken })
            // The browser of the recovery sign-in is itself signed in with the rotated token.
            const browser = await signInOverHttp({ id: newcomer.id, sessionToken: rotatedToken })
            const step = await confirmedSecondStep(browser.cookie, newcomer, {
                recovery: { userTokenAtStart: rotatedToken },
            })

            failures.claim = 'throw'
            expect(payloadOf(await step.continue())).toMatchObject({
                reason: 'mfa_completion_pending',
            })
            expect(await stale.isStored()).toBe(false)
            expect(await browser.isStored()).toBe(true)

            expect((await step.continue()).status).toBe('ok')
            expect(step.issuedNewSession()).toBe(true)
            expect(await browser.isStored()).toBe(false)
            expect(effects.notifyNewSignIn).toHaveBeenCalledTimes(1)
        })

        it('a recovery sign-in without failures: cleaned up before the answer; a lost answer repeated is harmless', async () => {
            const { newcomer, rotatedToken, stale, step } = await recoverySetup()

            expect((await step.continue()).status).toBe('ok')
            expect(step.issuedNewSession()).toBe(true)
            // Awaited before the success answer.
            expect(await stale.isStored()).toBe(false)
            expect(effects.closeUserConnections).toHaveBeenCalledTimes(1)
            expect(effects.closeUserConnections).toHaveBeenCalledWith(String(newcomer.id), {
                exceptSessionId: step.plan.sessionId,
                userToken: rotatedToken,
            })
            expect(effects.notifyNewSignIn).toHaveBeenCalledTimes(1)
            expect(effects.announceMfaChange).toHaveBeenCalledTimes(1)

            // The answer was lost: the repeat cleans up again (nothing left) and sends nothing.
            expect((await step.continue()).status).toBe('ok')
            expect(step.issuedNewSession()).toBe(true)
            expect(effects.closeUserConnections).toHaveBeenCalledTimes(2)
            expect(effects.notifyNewSignIn).toHaveBeenCalledTimes(1)
            expect(effects.announceMfaChange).toHaveBeenCalledTimes(1)
            expect(
                (await storage.listSessions(rotatedToken, { after: null })).sessions,
            ).toHaveLength(0)
            expect(await storage.sessionExists(step.plan.sessionId, newcomer.sessionToken)).toBe(
                true,
            )
        })
    })
})
