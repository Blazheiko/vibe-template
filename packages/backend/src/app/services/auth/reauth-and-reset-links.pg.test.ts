import { eq, inArray } from 'drizzle-orm'
import { hashPassword } from 'metautil'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { hasPg } from '../../../test-support/pg-test-db.js'
import {
    cleanupTestRedis,
    createTestRedis,
    hasRedis,
} from '../../../test-support/redis-test-client.js'
import { appErrorMessage } from '../shared/errors.js'

// feat-129: the session-still-stored guard is required; these cases keep the session.
const sessionStillStored = (): Promise<boolean> => Promise.resolve(true)

// feat-109 (R06b) on real PostgreSQL and Redis:
// - the current-password re-check of link-email / link-phone spends the per-user budget of
//   change-password before the check, so a stolen session cannot guess the password through it;
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

    const run = `${String(Date.now())}-${String(process.pid)}`
    const userIds: bigint[] = []
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

    const insertResetLink = async (userId: bigint) => {
        counter += 1
        const [row] = await db
            .insert(passwordResetTokens)
            .values({
                userId,
                tokenHash: `reauth-${run}-${String(counter)}`.padEnd(64, '0').slice(0, 64),
                expiresAt: new Date(Date.now() + 60 * 60_000),
            })
            .returning()
        if (row === undefined) throw new Error('reset link not inserted')
        return row
    }

    const linkUsedAt = async (id: bigint) => {
        const [row] = await db
            .select({ usedAt: passwordResetTokens.usedAt })
            .from(passwordResetTokens)
            .where(eq(passwordResetTokens.id, id))
        return row?.usedAt ?? null
    }

    const userRow = async (id: bigint) => {
        const [row] = await db.select().from(users).where(eq(users.id, id))
        if (row === undefined) throw new Error('user gone')
        return row
    }

    const startLink = (user: { id: bigint; sessionToken: string }, currentPassword: string) =>
        authService.startEmailLink(
            user.id,
            { email: `new-${run}-${String(counter)}@example.test`, currentPassword },
            user.sessionToken,
            sessionStillStored,
        )

    const message = (result: { isErr(): boolean; error?: unknown }): string | undefined =>
        result.isErr() ? appErrorMessage(result.error as never) : undefined

    it('the 11th password re-check is refused even with the right password', async () => {
        const user = await insertUser(false)

        for (let attempt = 0; attempt < 10; attempt += 1) {
            expect(message(await startLink(user, 'wrong-password'))).toBe(
                'Current password is incorrect',
            )
        }

        expect(message(await startLink(user, PASSWORD))).toBe(
            'Too many password attempts. Please try again later.',
        )
    })

    it('shares the budget with change-password', async () => {
        const user = await insertUser(false)
        for (let attempt = 0; attempt < 10; attempt += 1) {
            await startLink(user, 'wrong-password')
        }

        const change = await authService.changePassword(
            user.id,
            { currentPassword: PASSWORD, newPassword: 'another-password-456' },
            user.sessionToken,
            sessionStillStored,
        )

        expect(message(change)).toBe('Too many password change attempts. Please try again later.')
        expect((await userRow(user.id)).password).toBe(passwordHash)
    })

    it('a right password resets the budget', async () => {
        const user = await insertUser(false)
        for (let attempt = 0; attempt < 9; attempt += 1) {
            await startLink(user, 'wrong-password')
        }
        expect(message(await startLink(user, PASSWORD))).not.toBe(
            'Too many password attempts. Please try again later.',
        )

        for (let attempt = 0; attempt < 9; attempt += 1) {
            expect(message(await startLink(user, 'wrong-password'))).toBe(
                'Current password is incorrect',
            )
        }
    })

    it('change-password retires the pending reset links', async () => {
        const user = await insertUser()
        const link = await insertResetLink(user.id)

        const change = await authService.changePassword(
            user.id,
            { currentPassword: PASSWORD, newPassword: 'another-password-456' },
            user.sessionToken,
            sessionStillStored,
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
                { currentPassword: PASSWORD, newPassword: 'another-password-456' },
                user.sessionToken,
                sessionStillStored,
            ),
        ).rejects.toThrow('injected')

        const after = await userRow(user.id)
        expect(after.password).toBe(passwordHash)
        expect(after.sessionToken).toBe(user.sessionToken)
        expect(await linkUsedAt(link.id)).toBeNull()
    })

    const logoutAll = (user: { id: bigint; sessionToken: string }) =>
        authService.logoutAll(
            {
                getUserId: () => String(user.id),
                getPresentedUserToken: () => user.sessionToken,
                logoutAll: () => Promise.resolve({ deleted: 0, complete: true }),
            } as never,
            { sessionInfo: { id: 's', data: { csrfToken: 'c'.repeat(43) } } } as never,
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

        const result = await logoutAll({ id: user.id, sessionToken: 'stale-token' })

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
                codeHash: 'hash',
                resendAvailableAt: new Date(),
                expiresAt: new Date(Date.now() + 10 * 60_000),
            })
            .returning()
        if (row === undefined) throw new Error('challenge not inserted')
        return row
    }

    const challengeInvalidatedAt = async (id: string) => {
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
            { currentPassword: PASSWORD, newPassword: 'another-password-456' },
            user.sessionToken,
            sessionStillStored,
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

        expect((await logoutAll({ id: user.id, sessionToken: 'stale-token' })).isErr()).toBe(true)

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
            { email: `gone-${run}@example.test`, currentPassword: PASSWORD },
            user.sessionToken,
            () => Promise.resolve(false),
        )

        expect(result.isErr() && result.error).toMatchObject({
            _tag: 'Unauthorized',
            reason: 'session_revoked',
        })
        expect(sendLink).not.toHaveBeenCalled()
    })

    it('the guard is asked after the password check, right before the mail', async () => {
        const user = await insertUser(false)
        const guard = vi.fn(() => Promise.resolve(true))

        const result = await authService.startEmailLink(
            user.id,
            { email: `kept-${run}@example.test`, currentPassword: PASSWORD },
            user.sessionToken,
            guard,
        )

        expect(result.isOk()).toBe(true)
        expect(guard).toHaveBeenCalledTimes(1)
    })

    // feat-123: a spent password budget is 429.
    it('the 11th password re-check answers 429', async () => {
        const user = await insertUser(false)
        for (let attempt = 0; attempt < 10; attempt += 1) await startLink(user, 'wrong-password')

        const result = await startLink(user, PASSWORD)

        expect(result.isErr() && result.error).toMatchObject({ _tag: 'RateLimited' })
    })
})
