import { and, eq, lt } from 'drizzle-orm'
import type { InferSelectModel } from 'drizzle-orm'

import { db } from '#database/db.js'
import { totpFactors } from '#database/schema.js'
import type { DbExecutor } from '../transaction.js'
import type { TotpFactorId, UserId } from '#app/domain/ids.js'

export type TotpFactorRow = InferSelectModel<typeof totpFactors>

export interface NewTotpFactor {
    userId: UserId
    enrollmentId: string
    secretCiphertext: Buffer
    keyId: string
    lastUsedStep: bigint
    confirmedAt: Date
}

// feat-245 (docs/plan/passkeys-mfa-plan.md, Р7, Р9). Every method that changes a factor runs in
// the caller's transaction under the user's row lock.
export interface ITotpFactorRepository {
    findByUserId(userId: UserId, executor?: DbExecutor): Promise<TotpFactorRow | undefined>
    /** The version a confirmation of this enrollment created, if it is still the user's factor. */
    findByEnrollment(
        userId: UserId,
        enrollmentId: string,
        executor?: DbExecutor,
    ): Promise<TotpFactorRow | undefined>
    /**
     * Writes a new version: the previous one of the user (if any) goes in the same statement order
     * of the caller's transaction. Answers the new row and whether a previous one was replaced.
     */
    replace(
        factor: NewTotpFactor,
        tx: DbExecutor,
    ): Promise<{ created: TotpFactorRow; replaced: boolean }>
    /**
     * Spends `step` for the version `id` whose secret checked the code (Р7): true only when that
     * version is still the user's and no later or equal step was spent. Of two requests with one
     * code one gets true; a replacement in between makes both false.
     */
    consumeStep(
        userId: UserId,
        id: TotpFactorId,
        step: bigint,
        executor?: DbExecutor,
    ): Promise<boolean>
    /** Removes the factor of the user; true when there was one. */
    deleteByUserId(userId: UserId, executor: DbExecutor): Promise<boolean>
}

export const totpFactorRepository: ITotpFactorRepository = {
    async findByUserId(userId, executor = db) {
        return executor
            .select()
            .from(totpFactors)
            .where(eq(totpFactors.userId, userId))
            .limit(1)
            .then((rows) => rows.at(0))
    },

    async findByEnrollment(userId, enrollmentId, executor = db) {
        return executor
            .select()
            .from(totpFactors)
            .where(and(eq(totpFactors.userId, userId), eq(totpFactors.enrollmentId, enrollmentId)))
            .limit(1)
            .then((rows) => rows.at(0))
    },

    async replace(factor, tx) {
        const removed = await tx
            .delete(totpFactors)
            .where(eq(totpFactors.userId, factor.userId))
            .returning({ id: totpFactors.id })
        const [created] = await tx
            .insert(totpFactors)
            .values({ ...factor, createdAt: new Date() })
            .returning()
        if (created === undefined) throw new Error('totp factor insert returned no row')
        return { created, replaced: removed.length > 0 }
    },

    async consumeStep(userId, id, step, executor = db) {
        const updated = await executor
            .update(totpFactors)
            .set({ lastUsedStep: step })
            .where(
                and(
                    eq(totpFactors.id, id),
                    eq(totpFactors.userId, userId),
                    lt(totpFactors.lastUsedStep, step),
                ),
            )
            .returning({ id: totpFactors.id })
        return updated.length > 0
    },

    async deleteByUserId(userId, executor) {
        const removed = await executor
            .delete(totpFactors)
            .where(eq(totpFactors.userId, userId))
            .returning({ id: totpFactors.id })
        return removed.length > 0
    },
}
