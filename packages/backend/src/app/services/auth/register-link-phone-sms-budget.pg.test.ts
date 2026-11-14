import { inArray } from 'drizzle-orm'
import { Result } from 'better-result'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { hasPg } from '../../../test-support/pg-test-db.js'

// feat-214 (security review 2026-11-12 follow-ups, item 8): register/phone/start and
// link-phone/start spent the hourly SMS budget of the number before the resend cooldown was
// checked under the advisory lock. A start that cooldown refused, one after another or in a
// parallel burst, had paid all the same: anyone could use up the budget of somebody else's
// number without one SMS being sent. The same order feat-212 fixed for the phone reset. Real
// PostgreSQL (the lock and the transaction); the throttle is a counter in memory, so the test
// reads exactly what was spent.

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
vi.mock('#app/services/auth/sms-verification-provider.js', () => ({
    smsVerificationProvider: {
        issueVerificationCode: () =>
            Promise.resolve({ code: '123456', providerRequestId: 'fake-request' }),
    },
}))
// The re-check of the current password in link-phone/start is not under test here.
vi.mock('metautil', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    validatePassword: () => Promise.resolve(true),
}))

describe.skipIf(!hasPg)('SMS budget of register and link phone starts on PostgreSQL', async () => {
    const { db, pool } = await import('#database/db.js')
    const { sessionCheckPool } = await import('#database/session-check-db.js')
    const { smsAuthChallenges, users } = await import('#database/schema.js')
    const { authService } = await import('#app/services/auth/auth-service.js')
    const { authConfig: readonlyAuthConfig } = await import('#config/auth.js')
    const authConfig = readonlyAuthConfig as {
        -readonly [K in keyof typeof readonlyAuthConfig]: (typeof readonlyAuthConfig)[K]
    }
    const saved = {
        phoneAuthEnabled: authConfig.phoneAuthEnabled,
        otpHmacKey: authConfig.otpHmacKey,
    }

    const phones: string[] = []
    const userIds: bigint[] = []
    let counter = 0
    const newPhone = (): string => {
        counter += 1
        const phone = `+1202556${String((Date.now() + counter * 7) % 10_000).padStart(4, '0')}`
        phones.push(phone)
        return phone
    }

    beforeEach(() => {
        authConfig.phoneAuthEnabled = true
        authConfig.otpHmacKey = 'register-link-sms-budget-otp-key-0123456789'
        throttle.spent.clear()
        throttle.smsLimit = Number.POSITIVE_INFINITY
    })

    afterAll(async () => {
        Object.assign(authConfig, saved)
        if (phones.length > 0) {
            await db.delete(smsAuthChallenges).where(inArray(smsAuthChallenges.phone, phones))
        }
        if (userIds.length > 0) await db.delete(users).where(inArray(users.id, userIds))
        await sessionCheckPool.end()
        await pool.end()
    })

    const newUser = async (): Promise<{ id: bigint; sessionToken: string }> => {
        const [row] = await db
            .insert(users)
            .values({ name: 'Budget Test', password: 'stored-hash' })
            .returning({ id: users.id, sessionToken: users.sessionToken })
        userIds.push(row!.id)
        return row!
    }

    const smsSpent = (phone: string): number => throttle.spent.get(`sms_send_phone:${phone}`) ?? 0
    const challenges = async (phone: string): Promise<number> =>
        (
            await db
                .select({ id: smsAuthChallenges.id })
                .from(smsAuthChallenges)
                .where(inArray(smsAuthChallenges.phone, [phone]))
        ).length

    const flows = [
        {
            name: 'register/phone/start',
            starter: async () => (phone: string, index: number) =>
                authService.startPhoneRegistration(
                    { phone },
                    { ipAddress: '203.0.113.9', sessionId: `session-${String(index)}` },
                ),
        },
        {
            name: 'link-phone/start',
            // Every start from its own account: the per-account budget is not what is tested.
            starter: async () => {
                const accounts = await Promise.all(Array.from({ length: 8 }, () => newUser()))
                return (phone: string, index: number) => {
                    const account = accounts[index]!
                    return authService.startPhoneLink(
                        account.id,
                        { phone, currentPassword: 'secret' },
                        {
                            ipAddress: '203.0.113.9',
                            sessionId: `session-${String(index)}`,
                            presentedSessionToken: account.sessionToken,
                            sessionStored: () => Promise.resolve(true),
                        },
                    )
                }
            },
        },
    ]

    describe.each(flows)('$name', ({ starter }) => {
        it('a burst of parallel starts spends the budget once: only one opens a challenge', async () => {
            const start = await starter()
            const phone = newPhone()

            const results = await Promise.all(
                Array.from({ length: 8 }, (_, index) => start(phone, index)),
            )

            expect(results.filter((result) => Result.isOk(result))).toHaveLength(1)
            expect(await challenges(phone)).toBe(1)
            // The other seven were refused by the resend cooldown under the lock and paid nothing.
            expect(smsSpent(phone)).toBe(1)
        })

        it('a start refused by the cooldown spends nothing, one after another too', async () => {
            const start = await starter()
            const phone = newPhone()

            const first = await start(phone, 0)
            const second = await start(phone, 1)

            expect(Result.isOk(first)).toBe(true)
            expect(Result.isError(second) && second.error).toMatchObject({
                reason: 'resend_cooldown_active',
            })
            expect(smsSpent(phone)).toBe(1)
        })

        it('a spent budget refuses the start under the lock and opens no challenge', async () => {
            const start = await starter()
            const phone = newPhone()
            throttle.smsLimit = 0

            const result = await start(phone, 0)

            expect(Result.isError(result) && result.error._tag).toBe('RateLimited')
            expect(await challenges(phone)).toBe(0)
        })
    })
})
