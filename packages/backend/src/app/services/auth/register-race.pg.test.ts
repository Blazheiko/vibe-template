import { Result } from 'better-result'
import { eq, inArray, sql } from 'drizzle-orm'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { hasPg } from '../../../test-support/pg-test-db.js'
import { bothReadBeforeEitherWrites } from '../../../test-support/race-barrier.js'

// feat-100: two registrations with one email (or phone completions / phone links with one
// number) both pass the lookup; the second write hits the unique index. It used to surface as
// 500 internal_error. Now the loser gets the answer of a taken identifier and nothing after
// the write runs. The barrier holds both requests after the lookup, before the write, so the
// second write really meets the index instead of seeing the first user in the lookup.

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
vi.mock('#app/services/auth/email-verification-service.js', () => ({
    emailVerificationService: { sendVerificationEmailAfterRegistration: vi.fn() },
}))
vi.mock('#vendor/utils/session/redis-session-storage.js', () => ({
    destroyAllSessions: () => Promise.resolve(0),
}))

const GENERIC = {
    status: 'success',
    message:
        'If the email can be used for registration, continue with the verification instructions sent to your inbox.',
}

describe.skipIf(!hasPg)('registration races on PostgreSQL', async () => {
    const { db, pool } = await import('#database/db.js')
    const { sessionCheckPool } = await import('#database/session-check-db.js')
    const { users, smsAuthChallenges } = await import('#database/schema.js')
    const { userRepository } = await import('#app/repositories/index.js')
    const { authService } = await import('#app/services/auth/auth-service.js')
    const { authConfig: readonlyAuthConfig } = await import('#config/auth.js')
    // The config is `as const`; the tests switch the registration mode at runtime.
    const authConfig = readonlyAuthConfig as {
        -readonly [K in keyof typeof readonlyAuthConfig]: (typeof readonlyAuthConfig)[K]
    }
    const { hashOtpVerificationCode } = await import('#app/services/auth/otp-verification-hash.js')
    const { hashPassword } = await import('metautil')

    const run = `${String(Date.now())}-${String(process.pid)}`
    const saved = {
        strictRegistration: authConfig.strictRegistration,
        phoneAuthEnabled: authConfig.phoneAuthEnabled,
        otpHmacKey: authConfig.otpHmacKey,
    }
    const emails: string[] = []
    const phones: string[] = []
    const createdUserIds: bigint[] = []
    let counter = 0

    const nextEmail = (): string => {
        counter += 1
        const email = `register-race-${String(counter)}-${run}@example.test`
        emails.push(email)
        return email
    }
    // Time-based so reruns against the same database do not collide; counter keeps calls apart.
    const nextPhone = (): string => {
        counter += 1
        const phone = `+1555${String(Date.now() % 1_000_000).padStart(6, '0')}${String(counter % 10)}`
        phones.push(phone)
        return phone
    }

    const fakeRequest = () => ({
        auth: { login: vi.fn(() => Promise.resolve(true)) },
        session: { sessionInfo: null, destroySession: vi.fn(() => Promise.resolve(undefined)) },
    })

    const usersWithEmail = async (email: string) =>
        await db
            .select({ id: users.id })
            .from(users)
            .where(sql`LOWER(${users.email}) = LOWER(${email})`)
    const usersWithPhone = async (phone: string) =>
        await db.select({ id: users.id }).from(users).where(eq(users.phone, phone))

    const insertChallenge = async (values: {
        flow: 'register_phone' | 'link_phone'
        phone: string
        metadata: Record<string, unknown>
        codeHash: string
        confirmedAt: Date | null
    }) => {
        const [row] = await db
            .insert(smsAuthChallenges)
            .values({
                ...values,
                resendAvailableAt: new Date(),
                expiresAt: new Date(Date.now() + 10 * 60_000),
            })
            .returning()
        if (row === undefined) throw new Error('challenge not inserted')
        return row
    }
    const challengeRow = async (id: string) => {
        const [row] = await db.select().from(smsAuthChallenges).where(eq(smsAuthChallenges.id, id))
        return row
    }

    beforeEach(() => {
        authConfig.phoneAuthEnabled = true
        authConfig.otpHmacKey = 'register-race-otp-key-0123456789abcdef'
    })

    afterEach(() => {
        vi.restoreAllMocks()
        Object.assign(authConfig, saved)
    })

    afterAll(async () => {
        if (phones.length > 0) {
            await db.delete(smsAuthChallenges).where(inArray(smsAuthChallenges.phone, phones))
        }
        for (const email of emails) {
            await db.delete(users).where(sql`LOWER(${users.email}) = LOWER(${email})`)
        }
        if (phones.length > 0) await db.delete(users).where(inArray(users.phone, phones))
        if (createdUserIds.length > 0) {
            await db.delete(users).where(inArray(users.id, createdUserIds))
        }
        await sessionCheckPool.end()
        await pool.end()
    })

    describe('email registration', () => {
        const register = (email: string, request: ReturnType<typeof fakeRequest>) =>
            authService.registerByEmail(
                { name: 'Racer', email, password: 'secret-123456', token: '' },
                request.auth as never,
                request.session as never,
                silent as never,
                { ipAddress: '127.0.0.1' },
            )

        it('strict: both answer the generic message, one user is created', async () => {
            authConfig.strictRegistration = true
            const email = nextEmail()
            const requests = [fakeRequest(), fakeRequest()]
            bothReadBeforeEitherWrites(userRepository, 'findByEmail')

            const results = await Promise.all(requests.map((request) => register(email, request)))

            for (const result of results) {
                expect(Result.isOk(result) && result.value).toEqual(GENERIC)
            }
            expect(await usersWithEmail(email)).toHaveLength(1)
            for (const request of requests) expect(request.auth.login).not.toHaveBeenCalled()
            // Only the winner leaves its anonymous session; the loser keeps it, like a taken address.
            const destroyed = requests.filter(
                (request) => request.session.destroySession.mock.calls.length > 0,
            )
            expect(destroyed).toHaveLength(1)
        })

        it('non-strict: the winner signs in, the loser answers the generic message', async () => {
            authConfig.strictRegistration = false
            const email = nextEmail()
            const requests = [fakeRequest(), fakeRequest()]
            bothReadBeforeEitherWrites(userRepository, 'findByEmail')

            const results = await Promise.all(requests.map((request) => register(email, request)))

            const signedIn = results.findIndex(
                (result) => Result.isOk(result) && 'user' in result.value,
            )
            expect(signedIn).toBeGreaterThanOrEqual(0)
            const loser = 1 - signedIn
            expect(Result.isOk(results[loser]!) && results[loser].value).toEqual(GENERIC)
            expect(await usersWithEmail(email)).toHaveLength(1)
            expect(requests[signedIn]!.auth.login).toHaveBeenCalledTimes(1)
            expect(requests[loser]!.auth.login).not.toHaveBeenCalled()
            expect(requests[loser]!.session.destroySession).not.toHaveBeenCalled()
        })
    })

    describe('phone registration completion', () => {
        it('two confirmed challenges for one number: one user, the other answers 409', async () => {
            const phone = nextPhone()
            // Inserted directly: starting the second one through the API would invalidate the
            // first, and the test would check the reuse of a challenge, not the unique index.
            const challenges = await Promise.all(
                ['race-session-a', 'race-session-b'].map((sessionId) =>
                    insertChallenge({
                        flow: 'register_phone',
                        phone,
                        metadata: { sessionId },
                        codeHash: 'confirmed',
                        confirmedAt: new Date(),
                    }),
                ),
            )
            const requests = [fakeRequest(), fakeRequest()]
            bothReadBeforeEitherWrites(userRepository, 'findByPhone')

            const results = await Promise.all(
                challenges.map((challenge, i) =>
                    authService.completePhoneRegistration(
                        {
                            challengeId: challenge.id,
                            name: 'Phone Racer',
                            password: 'secret-123456',
                            token: '',
                        },
                        requests[i]!.auth as never,
                        requests[i]!.session as never,
                        silent as never,
                        { sessionId: (challenge.metadata as { sessionId: string }).sessionId },
                    ),
                ),
            )

            const winner = results.findIndex((result) => Result.isOk(result))
            expect(winner).toBeGreaterThanOrEqual(0)
            const loser = 1 - winner
            expect(Result.isError(results[loser]!) && results[loser].error).toEqual({
                _tag: 'Conflict',
                message: 'Phone already exist',
            })
            expect(await usersWithPhone(phone)).toHaveLength(1)
            expect((await challengeRow(challenges[winner]!.id))?.invalidatedAt).not.toBeNull()
            expect((await challengeRow(challenges[loser]!.id))?.invalidatedAt).toBeNull()
            expect(requests[loser]!.auth.login).not.toHaveBeenCalled()
            expect(requests[loser]!.session.destroySession).not.toHaveBeenCalled()
        })
    })

    describe('phone link', () => {
        it('two accounts link one number: one gets it, the other answers 409', async () => {
            const phone = nextPhone()
            const password = await hashPassword('secret-123456')
            const accounts = await Promise.all(
                [1, 2].map(async (n) => {
                    const [row] = await db
                        .insert(users)
                        .values({ name: `link-racer-${String(n)}`, email: nextEmail(), password })
                        .returning()
                    if (row === undefined) throw new Error('user not inserted')
                    createdUserIds.push(row.id)
                    return row
                }),
            )
            // Each account has its own challenge from its own session.
            const challenges = await Promise.all(
                accounts.map((account) =>
                    insertChallenge({
                        flow: 'link_phone',
                        phone,
                        metadata: {
                            userId: String(account.id),
                            sessionId: `link-session-${String(account.id)}`,
                        },
                        codeHash: hashOtpVerificationCode('123456'),
                        confirmedAt: null,
                    }),
                ),
            )
            bothReadBeforeEitherWrites(userRepository, 'phoneExistsForOtherUser')

            const results = await Promise.all(
                accounts.map((account, i) =>
                    authService.confirmPhoneLink(
                        account.id,
                        { challengeId: challenges[i]!.id, code: '123456' },
                        {
                            ipAddress: '127.0.0.1',
                            sessionId: `link-session-${String(account.id)}`,
                            presentedSessionToken: account.sessionToken,
                        },
                    ),
                ),
            )

            const winner = results.findIndex((result) => Result.isOk(result))
            expect(winner).toBeGreaterThanOrEqual(0)
            const loser = 1 - winner
            expect(Result.isError(results[loser]!) && results[loser].error).toEqual({
                _tag: 'Conflict',
                message: 'Phone is already linked to another account',
            })
            const owners = await usersWithPhone(phone)
            expect(owners).toEqual([{ id: accounts[winner]!.id }])
            const [loserRow] = await db
                .select({ phone: users.phone })
                .from(users)
                .where(eq(users.id, accounts[loser]!.id))
            expect(loserRow?.phone).toBeNull()
        })
    })
})
