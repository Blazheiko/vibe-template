import { eq, inArray } from 'drizzle-orm'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { hasPg } from '../../../test-support/pg-test-db.js'
import { appErrorMessage } from '../shared/errors.js'
import type * as OtpHash from './otp-verification-hash.js'

// feat-103: the budget of wrong SMS codes holds under concurrency. Every request reads the
// challenge before any of them spends a try (the barrier below), so all of them hold the same
// stale row with attempt_count 0; only the atomic consumeAttempt decides how many codes are
// compared. Before feat-103 each request compared its code, whatever the budget said.

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

// Counts the comparisons, keeps the real hash check.
const comparisons = vi.hoisted(() => ({ count: 0 }))
vi.mock('#app/services/auth/otp-verification-hash.js', async (importOriginal) => {
    const actual = await importOriginal<typeof OtpHash>()
    return {
        ...actual,
        verifyOtpVerificationCode: (code: string, hash: string): boolean => {
            comparisons.count += 1
            return actual.verifyOtpVerificationCode(code, hash)
        },
    }
})

const PARALLEL = 10
const MAX = 3

describe.skipIf(!hasPg)('SMS attempt budget on PostgreSQL', async () => {
    const { db, pool } = await import('#database/db.js')
    const { sessionCheckPool } = await import('#database/session-check-db.js')
    const { smsAuthChallenges, users } = await import('#database/schema.js')
    const { smsAuthChallengeRepository } = await import('#app/repositories/index.js')
    const { authService } = await import('#app/services/auth/auth-service.js')
    const { passwordResetService } = await import('#app/services/auth/password-reset-service.js')
    const { confirmChallenge, verifySmsCode } = await import('#app/services/auth/sms-challenge.js')
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
    const challengeIds: string[] = []
    const userIds: bigint[] = []
    let counter = 0
    const nextPhone = (): string => {
        counter += 1
        return `+1556${String(Date.now() % 1_000_000).padStart(6, '0')}${String(counter % 10)}`
    }

    beforeEach(() => {
        authConfig.phoneAuthEnabled = true
        authConfig.otpHmacKey = 'sms-attempt-race-otp-key-0123456789abcdef'
        authConfig.smsMaxInvalidAttempts = MAX
        comparisons.count = 0
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

    const insertChallenge = async (values: {
        flow: 'register_phone' | 'link_phone' | 'reset_phone'
        metadata?: Record<string, unknown>
        attemptCount?: number
    }) => {
        const [row] = await db
            .insert(smsAuthChallenges)
            .values({
                flow: values.flow,
                phone: nextPhone(),
                metadata: values.metadata ?? {},
                attemptCount: values.attemptCount ?? 0,
                codeHash: hashOtpVerificationCode('123456'),
                resendAvailableAt: new Date(),
                expiresAt: new Date(Date.now() + 10 * 60_000),
            })
            .returning()
        if (row === undefined) throw new Error('challenge not inserted')
        challengeIds.push(row.id)
        return row
    }

    const challengeRow = async (id: string) => {
        const [row] = await db.select().from(smsAuthChallenges).where(eq(smsAuthChallenges.id, id))
        if (row === undefined) throw new Error('challenge gone')
        return row
    }

    // Holds every caller of findById until `readers` callers have read: all requests pass the
    // flow's own checks on the same row before any of them spends a try.
    const allReadBeforeAnySpends = (readers: number): void => {
        const original = smsAuthChallengeRepository.findById.bind(smsAuthChallengeRepository)
        let read = 0
        let release: () => void = () => undefined
        const gate = new Promise<void>((resolve) => {
            release = resolve
        })
        vi.spyOn(smsAuthChallengeRepository, 'findById').mockImplementation(async (id) => {
            const row = await original(id)
            read += 1
            if (read >= readers) release()
            await gate
            return row
        })
    }

    const wrongCodes = Array.from({ length: PARALLEL }, (_, index) =>
        String(100000 + index * 7 + 1),
    )

    it('compares at most the budget, whatever stale row the requests hold', async () => {
        const challenge = await insertChallenge({ flow: 'register_phone' })
        const answers = { noLongerValid: 'no longer valid' }

        const results = await Promise.all(
            wrongCodes.map((code) => verifySmsCode(challenge, code, answers)),
        )

        expect(comparisons.count).toBe(MAX)
        const messages = results.map((result) => (result.isErr() ? result.error : undefined))
        expect(
            messages.filter(
                (e) => e?._tag === 'BadRequest' && e.message === 'Invalid verification code',
            ),
        ).toHaveLength(MAX)
        expect(
            messages.filter((e) => e?._tag === 'BadRequest' && e.message === 'no longer valid'),
        ).toHaveLength(PARALLEL - MAX)
        const row = await challengeRow(challenge.id)
        expect(row.attemptCount).toBe(MAX)
        expect(row.invalidatedAt).not.toBeNull()
    })

    it('confirms once when two requests bring the right code', async () => {
        const challenge = await insertChallenge({ flow: 'register_phone' })
        const answers = { noLongerValid: 'no longer valid' }

        const outcomes = await Promise.all(
            [0, 1].map(async () => {
                const verified = await verifySmsCode(challenge, '123456', answers)
                if (verified.isErr()) return 'rejected'
                const confirmed = await confirmChallenge(challenge, answers)
                return confirmed.isOk() ? 'confirmed' : 'lost'
            }),
        )

        expect(outcomes.filter((outcome) => outcome === 'confirmed')).toHaveLength(1)
        const row = await challengeRow(challenge.id)
        expect(row.confirmedAt).not.toBeNull()
        expect(row.invalidatedAt).toBeNull()
    })

    it('a wrong code that spends the last try after the right one does not invalidate the confirmation', async () => {
        // Two tries left: the right code spends one, the wrong one spends the last.
        const challenge = await insertChallenge({ flow: 'register_phone', attemptCount: MAX - 2 })
        const answers = { noLongerValid: 'no longer valid' }

        // Hold the wrong request between its spent try and its invalidation.
        const original = smsAuthChallengeRepository.markInvalidatedIfPending.bind(
            smsAuthChallengeRepository,
        )
        let reached: () => void = () => undefined
        const atInvalidation = new Promise<void>((resolve) => {
            reached = resolve
        })
        let release: () => void = () => undefined
        const gate = new Promise<void>((resolve) => {
            release = resolve
        })
        vi.spyOn(smsAuthChallengeRepository, 'markInvalidatedIfPending').mockImplementation(
            async (id, executor) => {
                reached()
                await gate
                return await original(id, executor)
            },
        )

        expect((await verifySmsCode(challenge, '123456', answers)).isOk()).toBe(true)
        const late = verifySmsCode(challenge, '000000', answers)
        await atInvalidation
        expect((await confirmChallenge(challenge, answers)).isOk()).toBe(true)
        release()

        const lateResult = await late
        expect(lateResult.isErr() && appErrorMessage(lateResult.error)).toBe(
            'Invalid verification code',
        )
        const row = await challengeRow(challenge.id)
        expect(row.attemptCount).toBe(MAX)
        expect(row.confirmedAt).not.toBeNull()
        expect(row.invalidatedAt).toBeNull()
    })

    it('a wrong code on a confirmed challenge is not compared and changes nothing', async () => {
        const challenge = await insertChallenge({ flow: 'register_phone' })
        const answers = { noLongerValid: 'no longer valid' }
        expect((await verifySmsCode(challenge, '123456', answers)).isOk()).toBe(true)
        expect((await confirmChallenge(challenge, answers)).isOk()).toBe(true)
        comparisons.count = 0

        // The request still holds the row it read before the confirmation.
        const result = await verifySmsCode(challenge, '000000', answers)

        expect(result.isErr() && appErrorMessage(result.error)).toBe('no longer valid')
        expect(comparisons.count).toBe(0)
        const row = await challengeRow(challenge.id)
        expect(row.attemptCount).toBe(1)
        expect(row.invalidatedAt).toBeNull()
    })

    describe('through each flow, all requests past the flow checks first', () => {
        const expectBudgetHeld = async (challengeId: string) => {
            expect(comparisons.count).toBe(MAX)
            const row = await challengeRow(challengeId)
            expect(row.attemptCount).toBe(MAX)
            expect(row.invalidatedAt).not.toBeNull()
            expect(row.confirmedAt).toBeNull()
        }

        it('phone registration confirm', async () => {
            const challenge = await insertChallenge({ flow: 'register_phone' })
            allReadBeforeAnySpends(PARALLEL)

            await Promise.all(
                wrongCodes.map((code) =>
                    authService.confirmPhoneRegistration(
                        { challengeId: challenge.id, code },
                        { ipAddress: '203.0.113.1' },
                    ),
                ),
            )

            await expectBudgetHeld(challenge.id)
        })

        it('phone link confirm', async () => {
            const [user] = await db
                .insert(users)
                .values({ name: 'sms-race', email: `sms-race-${run}@example.test`, password: 'x' })
                .returning()
            if (user === undefined) throw new Error('user not inserted')
            userIds.push(user.id)
            const challenge = await insertChallenge({
                flow: 'link_phone',
                metadata: { userId: String(user.id), sessionId: 'session-1' },
            })
            allReadBeforeAnySpends(PARALLEL)

            await Promise.all(
                wrongCodes.map((code) =>
                    authService.confirmPhoneLink(
                        user.id,
                        { challengeId: challenge.id, code },
                        {
                            ipAddress: '203.0.113.1',
                            sessionId: 'session-1',
                            presentedSessionToken: user.sessionToken,
                        },
                    ),
                ),
            )

            await expectBudgetHeld(challenge.id)
        })

        it('phone password reset complete', async () => {
            const challenge = await insertChallenge({
                flow: 'reset_phone',
                metadata: { userId: '1' },
            })
            allReadBeforeAnySpends(PARALLEL)

            await Promise.all(
                wrongCodes.map((code) =>
                    passwordResetService.completePhonePasswordReset(
                        challenge.id,
                        code,
                        'new-password-123',
                        'new-password-123',
                        { ipAddress: '203.0.113.1' },
                    ),
                ),
            )

            await expectBudgetHeld(challenge.id)
        })
    })
})
