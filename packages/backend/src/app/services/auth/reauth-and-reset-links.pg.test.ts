import { eq, inArray } from 'drizzle-orm'
import type { OtpHash, SessionToken, TokenHash } from '#app/domain/secrets.js'
import { hashPassword } from 'metautil'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { hasPg } from '../../../test-support/pg-test-db.js'
import {
    cleanupTestRedis,
    createTestRedis,
    hasRedis,
} from '../../../test-support/redis-test-client.js'
import { appErrorMessage } from '../shared/errors.js'
import type { SessionAuthState } from 'shared/mfa'
import { testUserActor } from '../../../test-support/audit-actor.js'
import type { OneTimeTokenRowId, SmsChallengeId, UserId } from '#app/domain/ids.js'

// feat-129: the session-still-stored guard is required; these cases keep the session.
const sessionStillStored = (): Promise<boolean> => Promise.resolve(true)

// feat-109 (R06b) on real PostgreSQL and Redis:
// - the password re-check spends the per-user budget of change-password before the check, so a
//   stolen session cannot guess the password through it. feat-245: the re-check is the step-up of
//   POST /auth/reauth (stepUpService.reauth); link-email, link-phone and change-password take the
//   fresh mark it leaves on the session instead of a password in their form;
// - change-password and logout-all retire the pending password-reset links in the transaction
//   that rotates the credentials, and a failure retiring them rolls the rotation back.

const { redis } = vi.hoisted((): { redis: { client: unknown } } => ({ redis: { client: null } }))
vi.mock('#database/redis-rate-limit.js', () => ({
    get default() {
        return redis.client
    },
}))
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
vi.mock('#vendor/utils/session/redis-session-storage.js', () => ({
    destroyAllSessions: () => Promise.resolve({ deleted: 0, complete: true }),
}))
vi.mock('#app/services/notifications/user-notification-service.js', () => ({
    userNotificationService: { security: vi.fn() },
}))
vi.mock('#app/services/auth/email-verification-service.js', async () => {
    const { Result } = await import('better-result')
    return {
        emailVerificationService: {
            sendLinkVerificationEmail: vi.fn(() =>
                Promise.resolve(Result.ok({ message: 'Verification email sent' })),
            ),
            sendVerificationEmailAfterRegistration: vi.fn(),
        },
    }
})

const redisClient = createTestRedis()
redis.client = redisClient

const PASSWORD = 'current-password-123'

describe.skipIf(!hasPg || !hasRedis)('re-check budget and reset links (feat-109)', async () => {
    const { db, pool } = await import('#database/db.js')
    const { sessionCheckPool } = await import('#database/session-check-db.js')
    const { passwordResetTokens, smsAuthChallenges, users } = await import('#database/schema.js')
    const { RESET_PHONE_FLOW } = await import('#app/services/auth/auth-normalize.js')
    const { passwordResetRepository } = await import('#app/repositories/index.js')
    const { authService } = await import('#app/services/auth/auth-service.js')
    const { stepUpService } = await import('#app/services/auth/mfa/step-up.js')

    const run = `${String(Date.now())}-${String(process.pid)}`
    const userIds: UserId[] = []
    let counter = 0
    let passwordHash = ''

    beforeAll(async () => {
        await redisClient.connect()
        passwordHash = await hashPassword(PASSWORD)
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    afterAll(async () => {
        if (userIds.length > 0) await db.delete(users).where(inArray(users.id, userIds))
        await cleanupTestRedis(redisClient)
        await redisClient.quit()
        await sessionCheckPool.end()
        await pool.end()
    })

    const insertUser = async (withEmail = true) => {
        counter += 1
        const [user] = await db
            .insert(users)
            .values({
                name: `reauth-${String(counter)}`,
                ...(withEmail ? { email: `reauth-${run}-${String(counter)}@example.test` } : {}),
                password: passwordHash,
            })
            .returning()
        if (user === undefined) throw new Error('user not inserted')
        userIds.push(user.id)
        return user
    }

    const insertResetLink = async (userId: UserId) => {
        counter += 1
        const [row] = await db
            .insert(passwordResetTokens)
            .values({
                userId,
                tokenHash: `reauth-${run}-${String(counter)}`
                    .padEnd(64, '0')
                    .slice(0, 64) as TokenHash,
                expiresAt: new Date(Date.now() + 60 * 60_000),
            })
            .returning()
        if (row === undefined) throw new Error('reset link not inserted')
        return row
    }

    const linkUsedAt = async (id: OneTimeTokenRowId) => {
        const [row] = await db
            .select({ usedAt: passwordResetTokens.usedAt })
            .from(passwordResetTokens)
            .where(eq(passwordResetTokens.id, id))
        return row?.usedAt ?? null
    }

    const userRow = async (id: UserId) => {
        const [row] = await db.select().from(users).where(eq(users.id, id))
        if (row === undefined) throw new Error('user gone')
        return row
    }

    /** A session of `user` whose auth state the step-up writes to, as the session store does. */
    const sessionOf = () => {
        const state: { auth: SessionAuthState } = {
            auth: {
                v: 1,
                amr: ['pwd'],
                aal: 1,
                authenticatedAt: new Date(Date.now() - 3_600_000).toISOString(),
                verified: {},
            },
        }
        const session = {
            sessionInfo: { id: 's', data: {} },
            updateSessionAuth: (apply: (current: SessionAuthState) => SessionAuthState) => {
                state.auth = apply(state.auth)
                return Promise.resolve({ id: 's', data: { auth: state.auth } })
            },
        }
        return { state, session: session as never }
    }

    /** POST /auth/reauth with a password; the session's auth state after it. */
    const reauth = async (user: { id: UserId; sessionToken: SessionToken }, password: string) => {
        const { state, session } = sessionOf()
        const result = await stepUpService.reauth(
            { userId: user.id, session, presentedSessionToken: user.sessionToken },
            { proof: 'password', password },
        )
        return { result, auth: state.auth }
    }

    const freshPassword = (): SessionAuthState => ({
        v: 1,
        amr: ['pwd'],
        aal: 1,
        authenticatedAt: new Date().toISOString(),
        verified: { pwd: new Date().toISOString() },
    })

    const startLink = (
        user: { id: UserId; sessionToken: SessionToken },
        sessionAuth: SessionAuthState,
    ) =>
        authService.startEmailLink(
            user.id,
            { email: `new-${run}-${String(counter)}@example.test` },
            user.sessionToken,
            sessionStillStored,
            sessionAuth,
        )

    const message = (result: { isErr(): boolean; error?: unknown }): string | undefined =>
        result.isErr() ? appErrorMessage(result.error as never) : undefined

    it('the 11th password step-up is refused even with the right password', async () => {
        const user = await insertUser(false)

        for (let attempt = 0; attempt < 10; attempt += 1) {
            expect(message((await reauth(user, 'wrong-password')).result)).toBe(
                'Current password is incorrect',
            )
        }

        const last = await reauth(user, PASSWORD)
        expect(message(last.result)).toBe('Too many password attempts. Please try again later.')
        expect(last.auth.verified.pwd).toBeUndefined()
    })

    it('a spent budget leaves no fresh mark: change-password and link-email answer 403', async () => {
        const user = await insertUser(false)
        for (let attempt = 0; attempt < 10; attempt += 1) {
            await reauth(user, 'wrong-password')
        }
        const { auth } = await reauth(user, PASSWORD)

        const change = await authService.changePassword(
            user.id,
            { newPassword: 'another-password-456' },
            user.sessionToken,
            sessionStillStored,
            undefined,
            testUserActor(),
            auth,
        )
        const link = await startLink(user, auth)

        for (const refused of [change, link]) {
            expect(refused.isErr() && refused.error).toMatchObject({
                _tag: 'Forbidden',
                reason: 'reauth_required',
            })
        }
        expect((await userRow(user.id)).password).toBe(passwordHash)
    })

    it('a right password resets the budget and leaves a mark link-email accepts', async () => {
        const user = await insertUser(false)
        for (let attempt = 0; attempt < 9; attempt += 1) {
            await reauth(user, 'wrong-password')
        }
        const right = await reauth(user, PASSWORD)
        expect(right.result.isOk()).toBe(true)
        expect(right.auth.verified.pwd).toBeDefined()
        expect((await startLink(user, right.auth)).isOk()).toBe(true)

        for (let attempt = 0; attempt < 9; attempt += 1) {
            expect(message((await reauth(user, 'wrong-password')).result)).toBe(
                'Current password is incorrect',
            )
        }
    })

    it('link-email and change-password spend no password budget of their own', async () => {
        const user = await insertUser(false)
        for (let attempt = 0; attempt < 12; attempt += 1) {
            await startLink(user, freshPassword())
        }

        expect((await reauth(user, PASSWORD)).result.isOk()).toBe(true)
    })

    it('change-password retires the pending reset links', async () => {
        const user = await insertUser()
        const link = await insertResetLink(user.id)

        const change = await authService.changePassword(
            user.id,
            { newPassword: 'another-password-456' },
            user.sessionToken,
            sessionStillStored,
            undefined,
            testUserActor(),
            freshPassword(),
        )

        expect(change.isOk()).toBe(true)
        expect(await linkUsedAt(link.id)).not.toBeNull()
    })

    it('a failure retiring the links rolls the password change back', async () => {
        const user = await insertUser()
        const link = await insertResetLink(user.id)
        vi.spyOn(passwordResetRepository, 'invalidatePendingByUserId').mockRejectedValueOnce(
            new Error('injected'),
        )

        await expect(
            authService.changePassword(
                user.id,
                { newPassword: 'another-password-456' },
                user.sessionToken,
                sessionStillStored,
                undefined,
                testUserActor(),
                freshPassword(),
            ),
        ).rejects.toThrow('injected')

        const after = await userRow(user.id)
        expect(after.password).toBe(passwordHash)
        expect(after.sessionToken).toBe(user.sessionToken)
        expect(await linkUsedAt(link.id)).toBeNull()
    })

    const logoutAll = (user: { id: UserId; sessionToken: SessionToken }) =>
        authService.logoutAll(
            {
                getUserId: () => String(user.id),
                getPresentedUserToken: () => user.sessionToken,
                logoutAll: () => Promise.resolve({ deleted: 0, complete: true }),
            } as never,
            { sessionInfo: { id: 's', data: { csrfToken: 'c'.repeat(43) } } } as never,
            testUserActor(),
        )

    it('logout-all retires the pending reset links', async () => {
        const user = await insertUser()
        const link = await insertResetLink(user.id)

        const result = await logoutAll(user)

        expect(result.isOk()).toBe(true)
        expect((await userRow(user.id)).sessionToken).not.toBe(user.sessionToken)
        expect(await linkUsedAt(link.id)).not.toBeNull()
    })

    it('a failure retiring the links rolls the logout-all rotation back', async () => {
        const user = await insertUser()
        const link = await insertResetLink(user.id)
        vi.spyOn(passwordResetRepository, 'invalidatePendingByUserId').mockRejectedValueOnce(
            new Error('injected'),
        )

        await expect(logoutAll(user)).rejects.toThrow('injected')

        expect((await userRow(user.id)).sessionToken).toBe(user.sessionToken)
        expect(await linkUsedAt(link.id)).toBeNull()
    })

    it('a revoked session rotates nothing and retires nothing', async () => {
        const user = await insertUser()
        const link = await insertResetLink(user.id)

        const result = await logoutAll({ id: user.id, sessionToken: 'stale-token' as SessionToken })

        expect(result.isErr()).toBe(true)
        expect((await userRow(user.id)).sessionToken).toBe(user.sessionToken)
        expect(await linkUsedAt(link.id)).toBeNull()
    })

    // feat-121 (M4): change-password and logout-all end a phone reset asked for before them, as
    // an email reset does.
    const insertUserWithPhone = async () => {
        const user = await insertUser()
        counter += 1
        const phone = `+3805${String(Date.now()).slice(-6)}${String(counter).padStart(2, '0')}`
        await db.update(users).set({ phone }).where(eq(users.id, user.id))
        return { ...user, phone }
    }

    const insertPhoneReset = async (phone: string) => {
        const [row] = await db
            .insert(smsAuthChallenges)
            .values({
                flow: RESET_PHONE_FLOW,
                phone,
                codeHash: 'hash' as OtpHash,
                resendAvailableAt: new Date(),
                expiresAt: new Date(Date.now() + 10 * 60_000),
            })
            .returning()
        if (row === undefined) throw new Error('challenge not inserted')
        return row
    }

    const challengeInvalidatedAt = async (id: SmsChallengeId) => {
        const [row] = await db
            .select({ invalidatedAt: smsAuthChallenges.invalidatedAt })
            .from(smsAuthChallenges)
            .where(eq(smsAuthChallenges.id, id))
        return row?.invalidatedAt ?? null
    }

    it('change-password retires the pending phone-reset challenge', async () => {
        const user = await insertUserWithPhone()
        const challenge = await insertPhoneReset(user.phone)

        const change = await authService.changePassword(
            user.id,
            { newPassword: 'another-password-456' },
            user.sessionToken,
            sessionStillStored,
            undefined,
            testUserActor(),
            freshPassword(),
        )

        expect(change.isOk()).toBe(true)
        expect(await challengeInvalidatedAt(challenge.id)).not.toBeNull()
        await db.delete(smsAuthChallenges).where(eq(smsAuthChallenges.id, challenge.id))
    })

    it('logout-all retires the pending phone-reset challenge', async () => {
        const user = await insertUserWithPhone()
        const challenge = await insertPhoneReset(user.phone)

        expect((await logoutAll(user)).isOk()).toBe(true)

        expect(await challengeInvalidatedAt(challenge.id)).not.toBeNull()
        await db.delete(smsAuthChallenges).where(eq(smsAuthChallenges.id, challenge.id))
    })

    it('a revoked session retires no phone challenge either', async () => {
        const user = await insertUserWithPhone()
        const challenge = await insertPhoneReset(user.phone)

        expect(
            (await logoutAll({ id: user.id, sessionToken: 'stale-token' as SessionToken })).isErr(),
        ).toBe(true)

        expect(await challengeInvalidatedAt(challenge.id)).toBeNull()
        await db.delete(smsAuthChallenges).where(eq(smsAuthChallenges.id, challenge.id))
    })

    // feat-123 (L5): a single logout in another tab deletes the record without rotating the token;
    // the link flows ask right before their mail / SMS.
    it('link-email/start with a session deleted meanwhile: 401, no mail, no verification', async () => {
        const user = await insertUser(false)
        const { emailVerificationService } =
            await import('#app/services/auth/email-verification-service.js')
        const sendLink = vi.spyOn(emailVerificationService, 'sendLinkVerificationEmail')

        const result = await authService.startEmailLink(
            user.id,
            { email: `gone-${run}@example.test` },
            user.sessionToken,
            () => Promise.resolve(false),
            freshPassword(),
        )

        expect(result.isErr() && result.error).toMatchObject({
            _tag: 'Unauthorized',
            reason: 'session_revoked',
        })
        expect(sendLink).not.toHaveBeenCalled()
    })

    it('the guard is asked after the proof check, right before the mail', async () => {
        const user = await insertUser(false)
        const guard = vi.fn(() => Promise.resolve(true))

        const result = await authService.startEmailLink(
            user.id,
            { email: `kept-${run}@example.test` },
            user.sessionToken,
            guard,
            freshPassword(),
        )

        expect(result.isOk()).toBe(true)
        expect(guard).toHaveBeenCalledTimes(1)
    })

    // feat-123: a spent password budget is 429.
    it('the 11th password step-up answers 429', async () => {
        const user = await insertUser(false)
        for (let attempt = 0; attempt < 10; attempt += 1) await reauth(user, 'wrong-password')

        const { result } = await reauth(user, PASSWORD)

        expect(result.isErr() && result.error).toMatchObject({ _tag: 'RateLimited' })
    })
})
