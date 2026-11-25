import { asc, eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { hasPg } from '../../../test-support/pg-test-db.js'
import { bothReadBeforeEitherWrites } from '../../../test-support/race-barrier.js'
import { auditLogLines, testAdminActor } from '../../../test-support/audit-actor.js'
import { appErrorMessage } from '../shared/errors.js'
import type { UserId } from '#app/domain/ids.js'

// feat-235 (Р3, T5.5) on a real PostgreSQL: linking a phone confirms its SMS code in the
// transaction that writes the number and the `auth.phone.linked` event, under the user's row
// lock, with the session and the absence of a number checked again under it. A failure of the
// event, a refusal under the lock or the unique index rolls the confirmation back, so the code
// can be used again; two numbers linked at once from one account leave exactly one.

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

const CODE = '123456'
const sessionStillStored = (): Promise<boolean> => Promise.resolve(true)

describe.skipIf(!hasPg)('phone link and its audit event on PostgreSQL', async () => {
    const { db, pool } = await import('#database/db.js')
    const { sessionCheckPool } = await import('#database/session-check-db.js')
    const { auditEvents, smsAuthChallenges, users } = await import('#database/schema.js')
    const { userRepository } = await import('#app/repositories/index.js')
    const { auditService } = await import('#app/services/audit/audit-service.js')
    const { authService } = await import('#app/services/auth/auth-service.js')
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

    const now = Date.now()
    const userIds: UserId[] = []
    let counter = 0

    const nextPhone = (): string => {
        counter += 1
        return `+1559${String(now % 100_000).padStart(5, '0')}${String(counter).padStart(2, '0')}`
    }

    beforeEach(() => {
        authConfig.phoneAuthEnabled = true
        authConfig.otpHmacKey = 'phone-link-audit-otp-key-0123456789abcdef'
        authConfig.smsMaxInvalidAttempts = 5
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    afterAll(async () => {
        Object.assign(authConfig, saved)
        for (const id of userIds) {
            await db.delete(auditEvents).where(eq(auditEvents.targetUserId, id))
            await db.delete(users).where(eq(users.id, id))
        }
        await sessionCheckPool.end()
        await pool.end()
    })

    const insertUser = async () => {
        counter += 1
        const [user] = await db
            .insert(users)
            .values({ name: `phone-link-${String(counter)}`, email: null, password: 'hash' })
            .returning()
        if (user === undefined) throw new Error('user not inserted')
        userIds.push(user.id)
        return user
    }
    const insertChallenge = async (userId: UserId, phone: string) => {
        const [challenge] = await db
            .insert(smsAuthChallenges)
            .values({
                flow: 'link_phone',
                phone,
                metadata: { userId: String(userId), sessionId: `session-${String(userId)}` },
                codeHash: hashOtpVerificationCode(CODE),
                resendAvailableAt: new Date(),
                expiresAt: new Date(Date.now() + 10 * 60_000),
            })
            .returning()
        if (challenge === undefined) throw new Error('challenge not inserted')
        return challenge
    }
    const arrange = async () => {
        const user = await insertUser()
        const phone = nextPhone()
        const challenge = await insertChallenge(user.id, phone)
        return { user, phone, challenge }
    }
    const confirm = (
        user: { id: UserId; sessionToken: string },
        challengeId: string,
        actor = testAdminActor(user.id),
    ) =>
        authService.confirmPhoneLink(
            user.id,
            { challengeId, code: CODE },
            {
                ipAddress: '203.0.113.9',
                sessionId: `session-${String(user.id)}`,
                presentedSessionToken: user.sessionToken,
                sessionStored: sessionStillStored,
            },
            actor,
        )
    const challengeRow = async (id: string) => {
        const [row] = await db.select().from(smsAuthChallenges).where(eq(smsAuthChallenges.id, id))
        if (row === undefined) throw new Error('challenge gone')
        return row
    }
    const phoneOf = async (id: UserId) => {
        const [row] = await db.select({ phone: users.phone }).from(users).where(eq(users.id, id))
        return row?.phone ?? null
    }
    const eventsOf = (userId: UserId) =>
        db
            .select()
            .from(auditEvents)
            .where(eq(auditEvents.targetUserId, userId))
            .orderBy(asc(auditEvents.id))
    const message = (result: { isErr(): boolean; error?: unknown }): string | undefined =>
        result.isErr() ? appErrorMessage(result.error as never) : undefined

    it('a link writes exactly one auth.phone.linked by the user with the SMS code as proof', async () => {
        const { user, phone, challenge } = await arrange()
        const actor = testAdminActor(user.id)

        expect((await confirm(user, challenge.id, actor)).isOk()).toBe(true)

        expect(await phoneOf(user.id)).toBe(phone)
        const events = await eventsOf(user.id)
        expect(events).toHaveLength(1)
        expect(events[0]).toMatchObject({
            action: 'auth.phone.linked',
            actorKind: 'user',
            actorUserId: user.id,
            requestId: actor.requestId,
            metadata: { method: 'phone', proof: 'sms_code' },
        })
        expect(JSON.stringify(events[0]?.metadata)).not.toContain(phone)
        expect(auditLogLines(actor.logger)).toHaveLength(1)
    })

    it('a failed insert answers an error and the same code links the number on a retry', async () => {
        const { user, phone, challenge } = await arrange()
        vi.spyOn(auditService, 'record').mockRejectedValueOnce(new Error('audit insert failed'))

        await expect(confirm(user, challenge.id)).rejects.toThrow('audit insert failed')

        expect(await phoneOf(user.id)).toBeNull()
        const afterFailure = await challengeRow(challenge.id)
        expect(afterFailure.confirmedAt).toBeNull()
        // The try spent before the transaction stays spent (as in feat-106).
        expect(afterFailure.attemptCount).toBe(1)
        expect(await eventsOf(user.id)).toEqual([])

        expect((await confirm(user, challenge.id)).isOk()).toBe(true)
        expect(await phoneOf(user.id)).toBe(phone)
        expect((await challengeRow(challenge.id)).confirmedAt).not.toBeNull()
        expect(await eventsOf(user.id)).toHaveLength(1)
    })

    it('two numbers linked at once from one account: one is linked, the other refused', async () => {
        const user = await insertUser()
        const phones = [nextPhone(), nextPhone()]
        const challenges = [
            await insertChallenge(user.id, phones[0]!),
            await insertChallenge(user.id, phones[1]!),
        ]
        // Both requests pass every check before the transaction, then race for the row.
        bothReadBeforeEitherWrites(userRepository, 'phoneExistsForOtherUser')

        const results = await Promise.all(challenges.map((row) => confirm(user, row.id)))

        const winner = results.findIndex((result) => result.isOk())
        expect(winner).toBeGreaterThanOrEqual(0)
        const loser = 1 - winner
        expect(message(results[loser]!)).toBe('Phone is already linked to this account')
        // The first number stays; the loser neither overwrote it nor used up its code.
        expect(await phoneOf(user.id)).toBe(phones[winner])
        expect((await challengeRow(challenges[loser]!.id)).confirmedAt).toBeNull()
        expect((await challengeRow(challenges[winner]!.id)).confirmedAt).not.toBeNull()
        const events = await eventsOf(user.id)
        expect(events.map((event) => event.action)).toEqual(['auth.phone.linked'])
    })

    it('a session revoked after the checks is refused under the lock, the code unconfirmed', async () => {
        const { user, challenge } = await arrange()
        const check = userRepository.phoneExistsForOtherUser.bind(userRepository)
        vi.spyOn(userRepository, 'phoneExistsForOtherUser').mockImplementationOnce(
            async (...args) => {
                const answer = await check(...args)
                // Logout everywhere from another tab, between the checks and the transaction.
                await db
                    .update(users)
                    .set({ sessionToken: `rotated-${String(counter)}` })
                    .where(eq(users.id, user.id))
                return answer
            },
        )

        const result = await confirm(user, challenge.id)

        expect(result.isErr() && result.error).toMatchObject({ reason: 'session_revoked' })
        expect(await phoneOf(user.id)).toBeNull()
        expect((await challengeRow(challenge.id)).confirmedAt).toBeNull()
        expect(await eventsOf(user.id)).toEqual([])
    })

    it('the unique index (another account took the number) leaves the code unconfirmed', async () => {
        const { user, phone, challenge } = await arrange()
        const other = await insertUser()
        const check = userRepository.phoneExistsForOtherUser.bind(userRepository)
        vi.spyOn(userRepository, 'phoneExistsForOtherUser').mockImplementationOnce(
            async (...args) => {
                const answer = await check(...args)
                await db.update(users).set({ phone }).where(eq(users.id, other.id))
                return answer
            },
        )

        const result = await confirm(user, challenge.id)

        expect(message(result)).toBe('Phone is already linked to another account')
        expect(await phoneOf(user.id)).toBeNull()
        expect((await challengeRow(challenge.id)).confirmedAt).toBeNull()
        expect(await eventsOf(user.id)).toEqual([])
    })

    // The only case that tells withTransactionResult from withTransaction: a refusal returned
    // after the code was confirmed. Every other refusal comes before the confirmation, and the
    // unique index and a failed insert throw, which rolls back either.
    it('a refusal after the confirmation rolls the confirmation back', async () => {
        const { user, challenge } = await arrange()
        vi.spyOn(userRepository, 'update').mockResolvedValueOnce(undefined)

        const result = await confirm(user, challenge.id)

        expect(result.isErr()).toBe(true)
        expect((await challengeRow(challenge.id)).confirmedAt).toBeNull()
        expect(await phoneOf(user.id)).toBeNull()
        expect(await eventsOf(user.id)).toEqual([])
    })
})
