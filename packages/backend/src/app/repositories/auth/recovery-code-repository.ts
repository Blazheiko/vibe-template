import { and, count, eq, isNull } from 'drizzle-orm'

import { db } from '#database/db.js'
import { mfaRecoveryCodes } from '#database/schema.js'
import type { DbExecutor } from '../transaction.js'
import type { UserId } from '#app/domain/ids.js'
import type { RecoveryCodeHash } from '#app/domain/secrets.js'

// feat-245 (docs/plan/passkeys-mfa-plan.md, Р8): one-time recovery codes, stored as hashes.
export interface IRecoveryCodeRepository {
    countUnused(userId: UserId, executor?: DbExecutor): Promise<number>
    /** Voids every code of the user and writes a new batch, in the caller's transaction. */
    replaceBatch(
        userId: UserId,
        codeHashes: readonly RecoveryCodeHash[],
        batchId: string,
        tx: DbExecutor,
    ): Promise<void>
    /** Spends the code: true only for the request that marked it used (Р8, one-time under a race). */
    consume(userId: UserId, codeHash: RecoveryCodeHash, executor?: DbExecutor): Promise<boolean>
    /** Removes every code of the user; answers how many there were. */
    deleteByUserId(userId: UserId, executor: DbExecutor): Promise<number>
}

export const recoveryCodeRepository: IRecoveryCodeRepository = {
    async countUnused(userId, executor = db) {
        const [row] = await executor
            .select({ value: count() })
            .from(mfaRecoveryCodes)
            .where(and(eq(mfaRecoveryCodes.userId, userId), isNull(mfaRecoveryCodes.usedAt)))
        return row?.value ?? 0
    },

    async replaceBatch(userId, codeHashes, batchId, tx) {
        await tx.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, userId))
        if (codeHashes.length === 0) return
        const now = new Date()
        await tx
            .insert(mfaRecoveryCodes)
            .values(codeHashes.map((codeHash) => ({ userId, codeHash, batchId, createdAt: now })))
    },

    async consume(userId, codeHash, executor = db) {
        const updated = await executor
            .update(mfaRecoveryCodes)
            .set({ usedAt: new Date() })
            .where(
                and(
                    eq(mfaRecoveryCodes.userId, userId),
                    eq(mfaRecoveryCodes.codeHash, codeHash),
                    isNull(mfaRecoveryCodes.usedAt),
                ),
            )
            .returning({ id: mfaRecoveryCodes.id })
        return updated.length > 0
    },

    async deleteByUserId(userId, executor) {
        const removed = await executor
            .delete(mfaRecoveryCodes)
            .where(eq(mfaRecoveryCodes.userId, userId))
            .returning({ id: mfaRecoveryCodes.id })
        return removed.length
    },
}
