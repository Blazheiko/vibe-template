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
    const { runTokenTransaction, issueTokenLocked } =
        await import('#app/services/auth/one-time-token.js')
    const { withTransaction } = await import('#app/repositories/index.js')
    const { badRequest } = await import('#app/services/shared/errors.js')

    const now = Date.now()
    const OLD_PASSWORD = 'old-secret-123'
    const META = { ipAddress: '127.0.0.1' }
    const createdUserIds: bigint[] = []
    let counter = 0

    // An email link adds an address to an account without one (feat-096 checks it under
    // the lock), so those tests insert users with `withEmail: false`.
    const insertUser = async (verified = false, withEmail = true) => {
        counter += 1
        const [row] = await db
            .insert(users)
            .values({
                name: `token-race-${String(counter)}`,
                email: withEmail
                    ? `token-race-${String(counter)}-${String(now)}@example.test`
                    : null,
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

            // ADR 0004: the failure propagates (the transport answers 500).
            await expect(reset(token.raw, 'new-secret-456')).rejects.toThrow()
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

            // Before: the password was already changed and the link stayed usable (replay).
            // ADR 0004: the failure propagates (the transport answers 500).
            await expect(reset(token.raw, 'new-secret-456')).rejects.toThrow()
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

            // ADR 0004: the failure propagates (the transport answers 500).
            await expect(verify(token.raw)).rejects.toThrow()
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
            const user = await insertUser(true, false)
            const target = `linked-race-${String(now)}@example.test`
            const token = await newLinkToken(user.id, target)
            bothReadBeforeEitherWrites(emailLinkVerificationRepository, 'findByTokenHash')

            const results = await Promise.all([link(token.raw), link(token.raw)])

            expect(results.filter((result) => Result.isOk(result))).toHaveLength(1)
            expect(results.filter((result) => Result.isError(result))).toHaveLength(1)
            expect((await userRow(user.id))?.email).toBe(target)
            expect(await usedAt(emailLinkVerifications, token.id)).not.toBeNull()
        })

        // feat-090: the race the conflict check above cannot see. Another account holds the
        // address by the time of the update; the real unique index answers, wrapped by
        // Drizzle, and isUniqueViolation must still read it as a 409, not a 500.
        it('answers 409 when the unique index rejects the address, and keeps the link', async () => {
            const user = await insertUser(true, false)
            const other = await insertUser(true)
            const token = await newLinkToken(user.id, other.email ?? '')
            vi.spyOn(userRepository, 'findByEmail').mockResolvedValueOnce(undefined)

            const result = await link(token.raw)

            expect(Result.isError(result) && result.error).toMatchObject({
                _tag: 'Conflict',
                message: 'Email is already linked to another account',
            })
            expect((await userRow(user.id))?.email).toBe(user.email)
            expect(await usedAt(emailLinkVerifications, token.id)).toBeNull()
        })

        it('rolls the new email and the token back when the request fails after the write', async () => {
            const user = await insertUser(true, false)
            const target = `linked-rollback-${String(now)}@example.test`
            const token = await newLinkToken(user.id, target)
            failAfterWrite(userRepository, 'update')

            // ADR 0004: the failure propagates (the transport answers 500).
            await expect(link(token.raw)).rejects.toThrow()
            expect((await userRow(user.id))?.email).toBe(user.email)
            expect(await usedAt(emailLinkVerifications, token.id)).toBeNull()

            expect(Result.isOk(await link(token.raw))).toBe(true)
            expect((await userRow(user.id))?.email).toBe(target)
        })
    })

    // feat-096: the transaction contract itself, against real row locks.
    describe('runTokenTransaction and issueTokenLocked', () => {
        /** Holds the user's row lock in another transaction until `release` is called. */
        const holdUserLock = async (userId: bigint) => {
            let release: () => void = () => undefined
            const released = new Promise<void>((resolve) => {
                release = resolve
            })
            let locked: () => void = () => undefined
            const isLocked = new Promise<void>((resolve) => {
                locked = resolve
            })
            const done = withTransaction(async (tx) => {
                await userRepository.lockById(userId, tx)
                locked()
                await released
            })
            await isLocked
            return { release, done }
        }

        const pendingCount = async (
            table:
                | typeof passwordResetTokens
                | typeof emailVerifications
                | typeof emailLinkVerifications,
            userId: bigint,
        ): Promise<number> => {
            const rows = await db
                .select({ usedAt: table.usedAt })
                .from(table)
                .where(eq(table.userId, userId))
            return rows.filter((row) => row.usedAt === null).length
        }

        it("retires the other tables' pending tokens even when their id equals the consumed one", async () => {
            const user = await insertUser()
            // The same id in two tables: an exception by id would keep the reset token alive.
            const sharedId = 900_000_000n + BigInt(counter)
            const [verification] = await db
                .insert(emailVerifications)
                .values({
                    id: sharedId,
                    userId: user.id,
                    tokenHash: sha256(`v-${String(sharedId)}`),
                    expiresAt: future(),
                })
                .returning()
            await db.insert(passwordResetTokens).values({
                id: sharedId,
                userId: user.id,
                tokenHash: sha256(`r-${String(sharedId)}`),
                expiresAt: future(),
            })
            if (verification === undefined) throw new Error('token not inserted')

            const outcome = await runTokenTransaction(emailVerificationRepository, verification, {
                apply: () => Promise.resolve('done'),
                invalidate: [emailVerificationRepository, passwordResetRepository],
            })

            expect(outcome).toEqual({ kind: 'applied', value: 'done' })
            expect(await usedAt(emailVerifications, sharedId)).not.toBeNull()
            expect(await usedAt(passwordResetTokens, sharedId)).not.toBeNull()
            expect(await pendingCount(passwordResetTokens, user.id)).toBe(0)
        })

        it('refuses a token that expired while waiting for the user lock, changing nothing', async () => {
            const user = await insertUser()
            // Valid when the transaction starts, expired by the time it gets the lock.
            const token = await newResetToken(user.id, new Date(Date.now() + 1500))
            const [row] = await db
                .select()
                .from(passwordResetTokens)
                .where(eq(passwordResetTokens.id, token.id))
            if (row === undefined) throw new Error('token not found')
            const lock = await holdUserLock(user.id)
            const apply = vi.fn(() => Promise.resolve())

            const outcome = runTokenTransaction(passwordResetRepository, row, { apply })
            await new Promise((resolve) => setTimeout(resolve, 2500))
            lock.release()
            await lock.done

            expect(await outcome).toEqual({ kind: 'unusable', reason: 'expired' })
            expect(apply).not.toHaveBeenCalled()
            expect(await usedAt(passwordResetTokens, token.id)).toBeNull()
        }, 10_000)

        it('leaves exactly one usable token after two concurrent issuances', async () => {
            const user = await insertUser()

            const results = await Promise.all([
                issueTokenLocked(passwordResetRepository, { userId: user.id, ttlMs: 60_000 }),
                issueTokenLocked(passwordResetRepository, { userId: user.id, ttlMs: 60_000 }),
            ])

            expect(results.every((result) => Result.isOk(result))).toBe(true)
            expect(await pendingCount(passwordResetTokens, user.id)).toBe(1)
        })

        it('makes an issuance wait for a token transaction and check the row it left', async () => {
            const user = await insertUser(false)
            const token = await newVerificationToken(user.id)
            const [row] = await db
                .select()
                .from(emailVerifications)
                .where(eq(emailVerifications.id, token.id))
            if (row === undefined) throw new Error('token not found')
            let applying: () => void = () => undefined
            const isApplying = new Promise<void>((resolve) => {
                applying = resolve
            })
            let finish: () => void = () => undefined
            const finished = new Promise<void>((resolve) => {
                finish = resolve
            })

            // The verification holds the lock while it applies ...
            const verified = runTokenTransaction(emailVerificationRepository, row, {
                apply: async (locked, tx) => {
                    await userRepository.update(locked.id, { emailVerifiedAt: new Date() }, tx)
                    applying()
                    await finished
                },
            })
            await isApplying
            // ... so a resend issued now waits, then sees the account verified.
            const issued = issueTokenLocked(emailVerificationRepository, {
                userId: user.id,
                ttlMs: 60_000,
                check: (locked) =>
                    locked.emailVerifiedAt === null
                        ? Result.ok(undefined)
                        : Result.err(badRequest('Email is already verified')),
            })
            // Long enough for the issuance to reach its read while the lock is held.
            await new Promise((resolve) => setTimeout(resolve, 300))
            finish()

            expect((await verified).kind).toBe('applied')
            const result = await issued
            expect(Result.isError(result) && result.error).toMatchObject({
                message: 'Email is already verified',
            })
            expect(await pendingCount(emailVerifications, user.id)).toBe(0)
        })
    })
})
