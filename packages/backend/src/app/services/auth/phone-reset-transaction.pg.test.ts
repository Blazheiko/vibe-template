import { eq, inArray } from 'drizzle-orm'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { hasPg } from '../../../test-support/pg-test-db.js'
import { appErrorMessage } from '../shared/errors.js'

// feat-106 (R06a): the phone password reset locks the user, re-checks the account on the locked
// row and confirms the challenge, retires the challenges and reset links and rotates the password
// in one transaction. A refusal or a failure after the confirmation rolls the confirmation back;
// a wrong code keeps its spent try.

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
vi.mock('#app/services/auth/auth-throttle-service.js', () => ({
    consumeAuthThrottle: () => Promise.resolve({ allowed: true, count: 1 }),
    resetAuthThrottle: () => Promise.resolve(undefined),
}))
vi.mock('#vendor/utils/session/redis-session-storage.js', () => ({
    destroyAllSessions: () => Promise.resolve({ deleted: 0, complete: true }),
}))
vi.mock('#app/services/notifications/user-notification-service.js', () => ({
    userNotificationService: { security: vi.fn() },
}))

const CODE = '123456'
const NEW_PASSWORD = 'new-password-123'

describe.skipIf(!hasPg)('phone password reset transaction on PostgreSQL', async () => {
    const { db, pool } = await import('#database/db.js')
    const { sessionCheckPool } = await import('#database/session-check-db.js')
    const { passwordResetTokens, smsAuthChallenges, users } = await import('#database/schema.js')
    const { passwordResetRepository, userRepository } = await import('#app/repositories/index.js')
    const { passwordResetService } = await import('#app/services/auth/password-reset-service.js')
    const { hashOtpVerificationCode } = await import('#app/services/auth/otp-verification-hash.js')
    const { authConfig: readonlyAuthConfig } = await import('#config/auth.js')
    const authConfig = readonlyAuthConfig as {
        -readonly [K in keyof typeof readonlyAuthConfig]: (typeof readonlyAuthConfig)[K]
    }

    const saved = {
        phoneAuthEnabled: authConfig.phoneAuthEnabled,
        otpHmacKey: authConfig.otpHmacKey,
        smsMaxInvalidAttempts: authConfig.smsMaxInvalidAttempts,
    }
    const run = `${String(Date.now())}-${String(process.pid)}`
    const userIds: bigint[] = []
    const challengeIds: string[] = []
    let counter = 0

    beforeEach(() => {
        authConfig.phoneAuthEnabled = true
        authConfig.otpHmacKey = 'phone-reset-tx-otp-key-0123456789abcdef'
        authConfig.smsMaxInvalidAttempts = 5
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    afterAll(async () => {
        Object.assign(authConfig, saved)
        if (challengeIds.length > 0) {
            await db.delete(smsAuthChallenges).where(inArray(smsAuthChallenges.id, challengeIds))
        }
        if (userIds.length > 0) await db.delete(users).where(inArray(users.id, userIds))
        await sessionCheckPool.end()
        await pool.end()
    })

    // A phone-only account and a reset challenge for it, as reset-phone/start leaves them.
    const arrange = async () => {
        counter += 1
        const phone = `+1557${String(Date.now() % 1_000_000).padStart(6, '0')}${String(counter % 10)}`
        const [user] = await db
            .insert(users)
            .values({ name: `reset-${String(counter)}`, phone, password: 'old-hash' })
            .returning()
        if (user === undefined) throw new Error('user not inserted')
        userIds.push(user.id)
        const [challenge] = await db
            .insert(smsAuthChallenges)
            .values({
                flow: 'reset_phone',
                phone,
                metadata: { userId: String(user.id) },
                codeHash: hashOtpVerificationCode(CODE),
                resendAvailableAt: new Date(),
                expiresAt: new Date(Date.now() + 10 * 60_000),
            })
            .returning()
        if (challenge === undefined) throw new Error('challenge not inserted')
        challengeIds.push(challenge.id)
        return { user, challenge }
    }

    const complete = (challengeId: string, code = CODE) =>
        passwordResetService.completePhonePasswordReset(
            challengeId,
            code,
            NEW_PASSWORD,
            NEW_PASSWORD,
            {
                ipAddress: '203.0.113.1',
            },
        )

    const userRow = async (id: bigint) => {
        const [row] = await db.select().from(users).where(eq(users.id, id))
        if (row === undefined) throw new Error('user gone')
        return row
    }
    const challengeRow = async (id: string) => {
        const [row] = await db.select().from(smsAuthChallenges).where(eq(smsAuthChallenges.id, id))
        if (row === undefined) throw new Error('challenge gone')
        return row
    }

    it('resets the password, rotates the session token and confirms the challenge', async () => {
        const { user, challenge } = await arrange()

        const result = await complete(challenge.id)

        expect(result.isOk()).toBe(true)
        const after = await userRow(user.id)
        expect(after.password).not.toBe('old-hash')
        expect(after.sessionToken).not.toBe(user.sessionToken)
        expect((await challengeRow(challenge.id)).confirmedAt).not.toBeNull()
    })

    it('a wrong code keeps its spent try and changes nothing else', async () => {
        const { user, challenge } = await arrange()

        const result = await complete(challenge.id, '000000')

        expect(result.isErr() && appErrorMessage(result.error)).toBe('Invalid verification code')
        const row = await challengeRow(challenge.id)
        expect(row.attemptCount).toBe(1)
        expect(row.confirmedAt).toBeNull()
        expect((await userRow(user.id)).password).toBe('old-hash')
    })

    it('waits for a concurrent email link and then refuses, before confirming', async () => {
        const { user, challenge } = await arrange()
        const email = `reset-link-${run}-${String(counter)}@example.test`

        // Another flow holds the user's row and links an email; the reset waits for the lock.
        let commitLink: () => void = () => undefined
        const linkCommitted = new Promise<void>((resolve) => {
            commitLink = resolve
        })
        let locked: () => void = () => undefined
        const linkHoldsLock = new Promise<void>((resolve) => {
            locked = resolve
        })
        const link = db.transaction(async (tx) => {
            await userRepository.lockById(user.id, tx)
            await tx.update(users).set({ email }).where(eq(users.id, user.id))
            locked()
            await linkCommitted
        })
        await linkHoldsLock

        const reset = complete(challenge.id)
        // The reset is blocked on the lock; let the link commit.
        await new Promise((resolve) => setTimeout(resolve, 100))
        commitLink()
        await link

        const result = await reset
        expect(result.isErr() && appErrorMessage(result.error)).toBe(
            'Phone reset challenge is invalid',
        )
        expect((await userRow(user.id)).password).toBe('old-hash')
        expect((await challengeRow(challenge.id)).confirmedAt).toBeNull()
    })

    it('a failure after the confirmation rolls the confirmation back; the code works again', async () => {
        const { user, challenge } = await arrange()
        vi.spyOn(userRepository, 'update').mockRejectedValueOnce(new Error('injected'))

        await expect(complete(challenge.id)).rejects.toThrow('injected')

        expect((await challengeRow(challenge.id)).confirmedAt).toBeNull()
        expect((await userRow(user.id)).password).toBe('old-hash')

        const retry = await complete(challenge.id)
        expect(retry.isOk()).toBe(true)
        const row = await challengeRow(challenge.id)
        expect(row.confirmedAt).not.toBeNull()
        expect(row.attemptCount).toBe(2)
    })

    it('a refusal returned after the confirmation rolls it back too (Result.err, not a throw)', async () => {
        const { user, challenge } = await arrange()
        vi.spyOn(userRepository, 'update').mockResolvedValueOnce(undefined)

        const result = await complete(challenge.id)

        expect(result.isErr() && appErrorMessage(result.error)).toBe('Failed to update password')
        expect((await challengeRow(challenge.id)).confirmedAt).toBeNull()
        expect((await userRow(user.id)).password).toBe('old-hash')
    })

    it('a failure retiring the reset links rolls back the password change', async () => {
        const { user, challenge } = await arrange()
        vi.spyOn(passwordResetRepository, 'invalidatePendingByUserId').mockRejectedValueOnce(
            new Error('injected'),
        )

        await expect(complete(challenge.id)).rejects.toThrow('injected')

        const after = await userRow(user.id)
        expect(after.password).toBe('old-hash')
        expect(after.sessionToken).toBe(user.sessionToken)
        expect((await challengeRow(challenge.id)).confirmedAt).toBeNull()
    })

    it('retires the pending email reset links of the account', async () => {
        const { user, challenge } = await arrange()
        const [pending] = await db
            .insert(passwordResetTokens)
            .values({
                userId: user.id,
                tokenHash: `reset-tx-${run}-${String(counter)}`,
                expiresAt: new Date(Date.now() + 60 * 60_000),
            })
            .returning()
        if (pending === undefined) throw new Error('reset link not inserted')

        expect((await complete(challenge.id)).isOk()).toBe(true)

        const [link] = await db
            .select()
            .from(passwordResetTokens)
            .where(eq(passwordResetTokens.id, pending.id))
        expect(link?.usedAt ?? null).not.toBeNull()
    })

    // An older invariant kept here as a regression guard: the conditional confirmation (before
    // R06a) already let only one completion through. What R06a adds, the single transaction, is
    // checked by the rollback cases above (feat-126: the review found this one would pass without it).
    it('two completions with the right code reset once (the conditional confirmation)', async () => {
        const { challenge } = await arrange()

        const results = await Promise.all([complete(challenge.id), complete(challenge.id)])

        expect(results.filter((result) => result.isOk())).toHaveLength(1)
        const refused = results.find((result) => result.isErr())
        if (refused?.isErr() !== true) throw new Error('no refused completion')
        expect(appErrorMessage(refused.error)).toBe('Phone reset challenge is no longer valid')
    })
})
