import { eq, sql } from 'drizzle-orm'
import { afterAll, describe, expect, it, vi } from 'vitest'

import { hasPg } from '../../../test-support/pg-test-db.js'
import type { UserId } from '#app/domain/ids.js'

vi.mock('#logger', () => ({
    default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

// feat-245 (docs/plan/passkeys-mfa-plan.md, Р7–Р9, tasks M3): the TOTP factors and the recovery
// codes as the migrations created them, and the conditional updates that make a code one-time.
describe.skipIf(!hasPg)('MFA storage on PostgreSQL', async () => {
    const { db, pool } = await import('#database/db.js')
    const { users, totpFactors, mfaRecoveryCodes, notifications } =
        await import('#database/schema.js')
    const { totpFactorRepository, recoveryCodeRepository } =
        await import('#app/repositories/index.js')
    const { withTransaction } = await import('#app/repositories/transaction.js')

    const created: UserId[] = []
    afterAll(async () => {
        for (const id of created) await db.delete(users).where(eq(users.id, id))
        await pool.end()
    })

    const newUser = async (): Promise<UserId> => {
        const [user] = await db
            .insert(users)
            .values({ name: 'mfa-storage', email: `${crypto.randomUUID()}@example.test` })
            .returning({ id: users.id })
        if (user === undefined) throw new Error('user not inserted')
        created.push(user.id)
        return user.id
    }

    const factor = (userId: UserId, enrollmentId = crypto.randomUUID().slice(0, 32)) => ({
        userId,
        enrollmentId,
        secretCiphertext: Buffer.from([1, 2, 3, 4]),
        keyId: 'k1',
        lastUsedStep: 100n,
        confirmedAt: new Date(),
    })

    it('replace writes a new version and removes the previous one in one transaction', async () => {
        const userId = await newUser()
        const first = await withTransaction((tx) =>
            totpFactorRepository.replace(factor(userId), tx),
        )
        expect(first.replaced).toBe(false)
        const second = await withTransaction((tx) =>
            totpFactorRepository.replace(factor(userId), tx),
        )
        expect(second.replaced).toBe(true)
        expect(second.created.id).not.toBe(first.created.id)
        const rows = await db.select().from(totpFactors).where(eq(totpFactors.userId, userId))
        expect(rows.map((row) => row.id)).toEqual([second.created.id])
        expect(rows[0]?.secretCiphertext.equals(Buffer.from([1, 2, 3, 4]))).toBe(true)
    })

    it('one factor per user and one row per enrollment id', async () => {
        const userId = await newUser()
        const enrollment = crypto.randomUUID().slice(0, 32)
        await db.insert(totpFactors).values(factor(userId, enrollment))
        await expect(db.insert(totpFactors).values(factor(userId))).rejects.toThrow()
        const other = await newUser()
        await expect(db.insert(totpFactors).values(factor(other, enrollment))).rejects.toThrow()
    })

    it('a step is spent once; parallel requests with one code get one success', async () => {
        const userId = await newUser()
        const { created } = await withTransaction((tx) =>
            totpFactorRepository.replace(factor(userId), tx),
        )
        const results = await Promise.all(
            Array.from({ length: 5 }, () =>
                totpFactorRepository.consumeStep(userId, created.id, 101n),
            ),
        )
        expect(results.filter(Boolean)).toHaveLength(1)
        // The same or an earlier step again: refused.
        expect(await totpFactorRepository.consumeStep(userId, created.id, 101n)).toBe(false)
        expect(await totpFactorRepository.consumeStep(userId, created.id, 100n)).toBe(false)
        expect(await totpFactorRepository.consumeStep(userId, created.id, 102n)).toBe(true)
    })

    it('a step of a replaced version is refused (the check named another secret)', async () => {
        const userId = await newUser()
        const old = await withTransaction((tx) => totpFactorRepository.replace(factor(userId), tx))
        await withTransaction((tx) => totpFactorRepository.replace(factor(userId), tx))
        expect(await totpFactorRepository.consumeStep(userId, old.created.id, 500n)).toBe(false)
        // And the id of another user's version spends nothing.
        const other = await newUser()
        const foreign = await withTransaction((tx) =>
            totpFactorRepository.replace(factor(other), tx),
        )
        expect(await totpFactorRepository.consumeStep(userId, foreign.created.id, 500n)).toBe(false)
    })

    it('a recovery code is spent once under a race; a new batch voids the old one', async () => {
        const userId = await newUser()
        await withTransaction((tx) =>
            recoveryCodeRepository.replaceBatch(userId, ['a'.repeat(64), 'b'.repeat(64)], 'b1', tx),
        )
        expect(await recoveryCodeRepository.countUnused(userId)).toBe(2)
        const results = await Promise.all(
            Array.from({ length: 5 }, () => recoveryCodeRepository.consume(userId, 'a'.repeat(64))),
        )
        expect(results.filter(Boolean)).toHaveLength(1)
        expect(await recoveryCodeRepository.countUnused(userId)).toBe(1)

        await withTransaction((tx) =>
            recoveryCodeRepository.replaceBatch(userId, ['c'.repeat(64)], 'b2', tx),
        )
        expect(await recoveryCodeRepository.consume(userId, 'b'.repeat(64))).toBe(false)
        expect(await recoveryCodeRepository.countUnused(userId)).toBe(1)
        // A code of another user is not this user's.
        const other = await newUser()
        expect(await recoveryCodeRepository.consume(other, 'c'.repeat(64))).toBe(false)
    })

    it('deleting the user removes the factor and the codes (cascade)', async () => {
        const userId = await newUser()
        await withTransaction(async (tx) => {
            await totpFactorRepository.replace(factor(userId), tx)
            await recoveryCodeRepository.replaceBatch(userId, ['d'.repeat(64)], 'b3', tx)
        })
        await db.delete(users).where(eq(users.id, userId))
        expect(await db.select().from(totpFactors).where(eq(totpFactors.userId, userId))).toEqual(
            [],
        )
        expect(
            await db.select().from(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, userId)),
        ).toEqual([])
    })

    it('notifications accept the MFA kinds', async () => {
        const userId = await newUser()
        for (const kind of [
            'security.mfa_enabled',
            'security.mfa_disabled',
            'security.recovery_codes_regenerated',
            'security.recovery_code_used',
        ]) {
            await db.insert(notifications).values({ userId, category: 'security', kind })
        }
        await expect(
            db.execute(
                sql`INSERT INTO notifications (user_id, category, kind) VALUES (${userId}, 'security', 'security.unknown')`,
            ),
        ).rejects.toThrow()
    })
})
