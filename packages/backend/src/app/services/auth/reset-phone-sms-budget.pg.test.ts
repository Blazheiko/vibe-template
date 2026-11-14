import { inArray } from 'drizzle-orm'
import { Result } from 'better-result'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { hasPg } from '../../../test-support/pg-test-db.js'

// feat-212 (security review 2026-11-12, L-3; found by a review of main @ 76c18a7): a phone
// reset start spent the hourly SMS budget of the number after a cooldown and capacity check made
// outside the advisory lock, and the check made again under the lock refused all but one of a
// burst of parallel starts. Every one of them had spent the budget: a burst could use up the
// budget of somebody else's number in a moment. Real PostgreSQL (the lock and the transaction);
// the throttle is a counter in memory, so the test reads exactly what was spent.

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

const throttle = vi.hoisted(() => ({
    spent: new Map<string, number>(),
    /** The limit of the per-phone SMS budget; the other budgets have none here. */
    smsLimit: Number.POSITIVE_INFINITY,
}))
vi.mock('#app/services/auth/auth-throttle-service.js', () => ({
    consumeAuthThrottle: (policy: { scope: string }, key: string) => {
        const name = `${policy.scope}:${key}`
        const count = (throttle.spent.get(name) ?? 0) + 1
        throttle.spent.set(name, count)
        const limit = policy.scope === 'sms_send_phone' ? throttle.smsLimit : Infinity
        return Promise.resolve({ allowed: count <= limit, count })
    },
    resetAuthThrottle: () => Promise.resolve(undefined),
}))

describe.skipIf(!hasPg)('SMS budget of a phone reset start on PostgreSQL', async () => {
    const { db, pool } = await import('#database/db.js')
    const { sessionCheckPool } = await import('#database/session-check-db.js')
    const { smsAuthChallenges } = await import('#database/schema.js')
    const { passwordResetService } = await import('#app/services/auth/password-reset-service.js')
    const { authConfig: readonlyAuthConfig } = await import('#config/auth.js')
    const authConfig = readonlyAuthConfig as {
        -readonly [K in keyof typeof readonlyAuthConfig]: (typeof readonlyAuthConfig)[K]
    }
    const saved = {
        phoneAuthEnabled: authConfig.phoneAuthEnabled,
        otpHmacKey: authConfig.otpHmacKey,
    }

    const phones: string[] = []
    let counter = 0
    // No account has these numbers: the challenge is a "blind" one and no SMS is sent, but the
    // budget of the number is spent all the same.
    const newPhone = (): string => {
        counter += 1
        const phone = `+1202555${String((Date.now() + counter * 7) % 10_000).padStart(4, '0')}`
        phones.push(phone)
        return phone
    }

    beforeEach(() => {
        authConfig.phoneAuthEnabled = true
        authConfig.otpHmacKey = 'reset-sms-budget-otp-key-0123456789abcdef'
        throttle.spent.clear()
        throttle.smsLimit = Number.POSITIVE_INFINITY
    })

    afterAll(async () => {
        Object.assign(authConfig, saved)
        if (phones.length > 0) {
            await db.delete(smsAuthChallenges).where(inArray(smsAuthChallenges.phone, phones))
        }
        await sessionCheckPool.end()
        await pool.end()
    })

    const start = (phone: string, sessionId: string) =>
        passwordResetService.startPhonePasswordReset(phone, undefined, {
            ipAddress: '203.0.113.9',
            sessionId,
        })
    const smsSpent = (phone: string): number => throttle.spent.get(`sms_send_phone:${phone}`) ?? 0
    const challenges = async (phone: string): Promise<number> =>
        (
            await db
                .select({ id: smsAuthChallenges.id })
                .from(smsAuthChallenges)
                .where(inArray(smsAuthChallenges.phone, [phone]))
        ).length

    it('a burst of parallel starts spends the budget once: only one of them opens a challenge', async () => {
        const phone = newPhone()

        const results = await Promise.all(
            Array.from({ length: 8 }, (_, index) => start(phone, `session-${String(index)}`)),
        )

        const opened = results.filter(
            (result) => Result.isOk(result) && result.value.challengeId !== undefined,
        )
        expect(opened).toHaveLength(1)
        expect(await challenges(phone)).toBe(1)
        // The other seven were refused by the resend cooldown under the lock, and paid nothing.
        expect(smsSpent(phone)).toBe(1)
    })

    it('a start refused by the cooldown spends nothing, one after another too', async () => {
        const phone = newPhone()

        const first = await start(phone, 'session-a')
        const second = await start(phone, 'session-b')

        expect(Result.isOk(first) && first.value.challengeId).toBeTruthy()
        expect(Result.isError(second)).toBe(true)
        expect(smsSpent(phone)).toBe(1)
    })

    it('a spent budget refuses the start under the lock and opens no challenge', async () => {
        const phone = newPhone()
        throttle.smsLimit = 0

        const result = await start(phone, 'session-a')

        expect(Result.isError(result) && result.error._tag).toBe('RateLimited')
        expect(await challenges(phone)).toBe(0)
    })
})
