import { db } from '#database/db.js'
import type { DbExecutor } from '../transaction.js'
import { passwordResetTokens } from '#database/schema.js'
import { and, eq, isNull, type InferInsertModel, type InferSelectModel } from 'drizzle-orm'

export type PasswordResetTokenRow = InferSelectModel<typeof passwordResetTokens>
export type PasswordResetTokenInsert = InferInsertModel<typeof passwordResetTokens>

export interface IPasswordResetRepository {
    create(data: PasswordResetTokenInsert): Promise<PasswordResetTokenRow>
    findByTokenHash(tokenHash: string): Promise<PasswordResetTokenRow | undefined>
    invalidatePendingByUserId(userId: bigint): Promise<number>
    /**
     * Claims the token: `used_at` is set only if it is still NULL, so of two concurrent
     * requests with one token exactly one gets the row back. Undefined: already used.
     * Pass the transaction in which the token's effect is applied.
     */
    markUsed(
        id: bigint,
        usedAt?: Date,
        executor?: DbExecutor,
    ): Promise<PasswordResetTokenRow | undefined>
}

export const passwordResetRepository: IPasswordResetRepository = {
    async create(data) {
        const [created] = await db.insert(passwordResetTokens).values(data).returning()
        if (created === undefined) {
            throw new Error('Failed to create password reset token')
        }

        return created
    },

    async findByTokenHash(tokenHash) {
        return await db
            .select()
            .from(passwordResetTokens)
            .where(eq(passwordResetTokens.tokenHash, tokenHash))
            .limit(1)
            .then((rows) => rows.at(0))
    },

    async invalidatePendingByUserId(userId) {
        const result = await db
            .update(passwordResetTokens)
            .set({ usedAt: new Date() })
            .where(and(eq(passwordResetTokens.userId, userId), isNull(passwordResetTokens.usedAt)))
            .returning({ id: passwordResetTokens.id })

        return result.length
    },

    async markUsed(id, usedAt = new Date(), executor = db) {
        return await executor
            .update(passwordResetTokens)
            .set({ usedAt })
            .where(and(eq(passwordResetTokens.id, id), isNull(passwordResetTokens.usedAt)))
            .returning()
            .then((rows) => rows.at(0))
    },
}
