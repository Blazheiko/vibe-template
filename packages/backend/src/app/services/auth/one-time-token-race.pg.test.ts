import { createHash } from 'node:crypto'

import { Result } from 'better-result'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

import { hasPg } from '../../../test-support/pg-test-db.js'

// feat-060: the reset, email-verification and email-link tokens are single-use. They
// used to be read, checked, applied and only then marked used, with `UPDATE ... WHERE
// id = ?` (no `used_at IS NULL`): two concurrent requests with one token both applied
// it. Now the token is claimed and the effect applied in ONE transaction. Real
// PostgreSQL; not under test here: throttling, notifications, the Redis cleanup.

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
vi.mock('#app/services/notifications/user-notification-service.js', () => ({
    userNotificationService: { security: vi.fn(), supportReply: vi.fn() },
}))
vi.mock('#vendor/utils/session/redis-session-storage.js', () => ({
    destroyAllSessions: () => Promise.resolve(0),
}))

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

describe.skipIf(!hasPg)('one-time tokens on PostgreSQL', async () => {
    const { db, pool } = await import('#database/db.js')
    const { sessionCheckPool } = await import('#database/session-check-db.js')
    const { users, passwordResetTokens, emailVerifications, emailLinkVerifications } =
        await import('#database/schema.js')
    const {
        userRepository,
        passwordResetRepository,
        emailVerificationRepository,
        emailLinkVerificationRepository,
    } = await import('#app/repositories/index.js')
    const { passwordResetService } = await import('#app/services/auth/password-reset-service.js')
    const { emailVerificationService } =
        await import('#app/services/auth/email-verification-service.js')
    const { hashPassword, validatePassword } = await import('metautil')

    const now = Date.now()
    const OLD_PASSWORD = 'old-secret-123'
    const META = { ipAddress: '127.0.0.1' }
    const createdUserIds: bigint[] = []
    let counter = 0

    const insertUser = async (verified = false) => {
        counter += 1
        const [row] = await db
            .insert(users)
            .values({
                name: `token-race-${String(counter)}`,
                email: `token-race-${String(counter)}-${String(now)}@example.test`,
                password: await hashPassword(OLD_PASSWORD),
                emailVerifiedAt: verified ? new Date() : null,
            })
            .returning()
        if (row === undefined) throw new Error('user not inserted')
        createdUserIds.push(row.id)
        return row
    }

    const future = (): Date => new Date(Date.now() + 60_000)

    const newResetToken = async (userId: bigint, expiresAt = future()) => {
        const raw = `reset-${crypto.randomUUID()}`
        const row = await passwordResetRepository.create({
            userId,
            tokenHash: sha256(raw),
            expiresAt,
        })
        return { raw, id: row.id }
    }
    const newVerificationToken = async (userId: bigint) => {
        const raw = `verify-${crypto.randomUUID()}`
        const row = await emailVerificationRepository.create({
            userId,
            tokenHash: sha256(raw),
            expiresAt: future(),
        })
        return { raw, id: row.id }
    }
    const newLinkToken = async (userId: bigint, targetEmail: string) => {
        const raw = `link-${crypto.randomUUID()}`
        const row = await emailLinkVerificationRepository.create({
            userId,
            targetEmail,
            tokenHash: sha256(raw),
            expiresAt: future(),
        })
        return { raw, id: row.id }
    }

    const userRow = async (id: bigint) => {
        const [row] = await db.select().from(users).where(eq(users.id, id))
        return row
    }
    const usedAt = async (
        table:
            typeof passwordResetTokens | typeof emailVerifications | typeof emailLinkVerifications,
        id: bigint,
    ): Promise<Date | null | undefined> => {
        const [row] = await db.select({ usedAt: table.usedAt }).from(table).where(eq(table.id, id))
        return row?.usedAt
    }

    /**
     * Holds the first caller of `method` after it has read until a second caller has
     * read too, so both requests have passed the "unused" check before either applies
     * the token: the race, made deterministic.
     */
    const bothReadBeforeEitherWrites = <T extends object>(
        repository: T,
        method: keyof T & string,
    ): void => {
        const original = (repository[method] as (...args: unknown[]) => Promise<unknown>).bind(
            repository,
        )
        let readers = 0
        let release: () => void = () => undefined
        const gate = new Promise<void>((resolve) => {
            release = resolve
        })
        vi.spyOn(repository, method as never).mockImplementation((async (...args: unknown[]) => {
            const result = await original(...args)
            readers += 1
            if (readers >= 2) release()
            await gate
            return result
        }) as never)
    }

    /** The write succeeds, then the request fails: what a crash right after it looks like. */
    const failAfterWrite = <T extends object>(repository: T, method: keyof T & string): void => {
        const original = (repository[method] as (...args: unknown[]) => Promise<unknown>).bind(
            repository,
        )
        vi.spyOn(repository, method as never).mockImplementationOnce((async (
            ...args: unknown[]
        ) => {
            await original(...args)
            throw new Error('failure after the write')
        }) as never)
    }

    afterEach(() => {
        vi.restoreAllMocks()
    })

    afterAll(async () => {
        for (const id of createdUserIds) await db.delete(users).where(eq(users.id, id))
        await sessionCheckPool.end()
        await pool.end()
    })

    describe('password reset token (email)', () => {
        const reset = (token: string, password: string) =>
            passwordResetService.resetPassword(token, password, password, META)

        it('lets exactly one of two concurrent resets with one token win', async () => {
            const user = await insertUser()
            const token = await newResetToken(user.id)
            bothReadBeforeEitherWrites(passwordResetRepository, 'findByTokenHash')

            const results = await Promise.all([
                reset(token.raw, 'winner-one-111'),
                reset(token.raw, 'winner-two-222'),
            ])

            const winners = results.filter((result) => Result.isOk(result))
            const losers = results.filter((result) => Result.isError(result))
            expect(winners).toHaveLength(1)
            expect(losers).toHaveLength(1)
            const loser = losers[0]
            if (loser !== undefined && Result.isError(loser)) {
                expect(loser.error).toMatchObject({ _tag: 'BadRequest', reason: 'used_token' })
            }

            // The stored password is the winner's, and only the winner's.
            const winnerPassword = Result.isOk(results[0]) ? 'winner-one-111' : 'winner-two-222'
            const loserPassword = Result.isOk(results[0]) ? 'winner-two-222' : 'winner-one-111'
            const row = await userRow(user.id)
            expect(await validatePassword(winnerPassword, row?.password ?? '')).toBe(true)
            expect(await validatePassword(loserPassword, row?.password ?? '')).toBe(false)
            expect(await usedAt(passwordResetTokens, token.id)).not.toBeNull()
        })

        it('rolls the password and the token back when the request fails after the write', async () => {
            const user = await insertUser()
            const token = await newResetToken(user.id)
            failAfterWrite(userRepository, 'update')

            const failed = await reset(token.raw, 'new-secret-456')

            expect(Result.isError(failed)).toBe(true)
            const row = await userRow(user.id)
            expect(await validatePassword(OLD_PASSWORD, row?.password ?? '')).toBe(true)
            expect(row?.sessionToken).toBe(user.sessionToken)
            expect(await usedAt(passwordResetTokens, token.id)).toBeNull()

            // Nothing was lost: the same link works.
            const retry = await reset(token.raw, 'new-secret-456')
            expect(Result.isOk(retry)).toBe(true)
            const after = await userRow(user.id)
            expect(await validatePassword('new-secret-456', after?.password ?? '')).toBe(true)
            expect(await usedAt(passwordResetTokens, token.id)).not.toBeNull()
        })

        it('does not change the password when marking the token used fails', async () => {
            const user = await insertUser()
            const token = await newResetToken(user.id)
            failAfterWrite(passwordResetRepository, 'markUsed')

            const failed = await reset(token.raw, 'new-secret-456')

            // Before: the password was already changed and the link stayed usable (replay).
            expect(Result.isError(failed)).toBe(true)
            const row = await userRow(user.id)
            expect(await validatePassword(OLD_PASSWORD, row?.password ?? '')).toBe(true)
            expect(await usedAt(passwordResetTokens, token.id)).toBeNull()
        })

        it('refuses a token that was already used', async () => {
            const user = await insertUser()
            const token = await newResetToken(user.id)
            expect(Result.isOk(await reset(token.raw, 'first-secret-111'))).toBe(true)

            const second = await reset(token.raw, 'second-secret-222')

            expect(Result.isError(second)).toBe(true)
            if (Result.isError(second)) {
                expect(second.error).toMatchObject({ reason: 'used_token' })
            }
            const row = await userRow(user.id)
            expect(await validatePassword('first-secret-111', row?.password ?? '')).toBe(true)
        })

        it('refuses an expired token and marks it used, as before', async () => {
            const user = await insertUser()
            const token = await newResetToken(user.id, new Date(Date.now() - 1000))

            const result = await reset(token.raw, 'new-secret-456')

            expect(Result.isError(result)).toBe(true)
            if (Result.isError(result)) {
                expect(result.error).toMatchObject({ reason: 'expired_token' })
            }
            expect(await usedAt(passwordResetTokens, token.id)).not.toBeNull()
            const row = await userRow(user.id)
            expect(await validatePassword(OLD_PASSWORD, row?.password ?? '')).toBe(true)
        })
    })

    describe('email verification token', () => {
        const verify = (token: string) => emailVerificationService.verifyEmail(token, META)

        it('lets exactly one of two concurrent verifications win', async () => {
            const user = await insertUser(false)
            const token = await newVerificationToken(user.id)
            bothReadBeforeEitherWrites(emailVerificationRepository, 'findByTokenHash')

            const results = await Promise.all([verify(token.raw), verify(token.raw)])

            expect(results.filter((result) => Result.isOk(result))).toHaveLength(1)
            expect(results.filter((result) => Result.isError(result))).toHaveLength(1)
            expect((await userRow(user.id))?.emailVerifiedAt).not.toBeNull()
            expect(await usedAt(emailVerifications, token.id)).not.toBeNull()
        })

        it('rolls the verification and the token back when the request fails after the write', async () => {
            const user = await insertUser(false)
            const token = await newVerificationToken(user.id)
            failAfterWrite(userRepository, 'update')

            const failed = await verify(token.raw)

            expect(Result.isError(failed)).toBe(true)
            expect((await userRow(user.id))?.emailVerifiedAt).toBeNull()
            expect(await usedAt(emailVerifications, token.id)).toBeNull()

            expect(Result.isOk(await verify(token.raw))).toBe(true)
            expect((await userRow(user.id))?.emailVerifiedAt).not.toBeNull()
            expect(await usedAt(emailVerifications, token.id)).not.toBeNull()
        })
    })

    describe('email link token', () => {
        const link = (token: string) => emailVerificationService.verifyEmail(token, META)

        it('lets exactly one of two concurrent links win', async () => {
            const user = await insertUser(true)
            const target = `linked-race-${String(now)}@example.test`
            const token = await newLinkToken(user.id, target)
            bothReadBeforeEitherWrites(emailLinkVerificationRepository, 'findByTokenHash')

            const results = await Promise.all([link(token.raw), link(token.raw)])

            expect(results.filter((result) => Result.isOk(result))).toHaveLength(1)
            expect(results.filter((result) => Result.isError(result))).toHaveLength(1)
            expect((await userRow(user.id))?.email).toBe(target)
            expect(await usedAt(emailLinkVerifications, token.id)).not.toBeNull()
        })

        it('rolls the new email and the token back when the request fails after the write', async () => {
            const user = await insertUser(true)
            const target = `linked-rollback-${String(now)}@example.test`
            const token = await newLinkToken(user.id, target)
            failAfterWrite(userRepository, 'update')

            const failed = await link(token.raw)

            expect(Result.isError(failed)).toBe(true)
            expect((await userRow(user.id))?.email).toBe(user.email)
            expect(await usedAt(emailLinkVerifications, token.id)).toBeNull()

            expect(Result.isOk(await link(token.raw))).toBe(true)
            expect((await userRow(user.id))?.email).toBe(target)
        })
    })
})
