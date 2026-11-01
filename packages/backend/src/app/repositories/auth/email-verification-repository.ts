import { db } from '#database/db.js'
import type { DbExecutor } from '../transaction.js'
import { emailVerifications } from '#database/schema.js'
import { and, eq, isNull, type InferInsertModel, type InferSelectModel } from 'drizzle-orm'

export type EmailVerificationRow = InferSelectModel<typeof emailVerifications>
export type EmailVerificationInsert = InferInsertModel<typeof emailVerifications>

export interface IEmailVerificationRepository {
    create(data: EmailVerificationInsert): Promise<EmailVerificationRow>
    findByTokenHash(tokenHash: string): Promise<EmailVerificationRow | undefined>
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
    ): Promise<EmailVerificationRow | undefined>
}

export const emailVerificationRepository: IEmailVerificationRepository = {
    async create(data) {
        const [created] = await db.insert(emailVerifications).values(data).returning()
        if (created === undefined) {
            throw new Error('Failed to create email verification')
        }

        return created
    },

    async findByTokenHash(tokenHash) {
        return await db
            .select()
            .from(emailVerifications)
            .where(eq(emailVerifications.tokenHash, tokenHash))
            .limit(1)
            .then((rows) => rows.at(0))
    },

    async invalidatePendingByUserId(userId) {
        const result = await db
            .update(emailVerifications)
            .set({ usedAt: new Date() })
            .where(and(eq(emailVerifications.userId, userId), isNull(emailVerifications.usedAt)))
            .returning({ id: emailVerifications.id })

        return result.length
    },

    async markUsed(id, usedAt = new Date(), executor = db) {
        return await executor
            .update(emailVerifications)
            .set({ usedAt })
            .where(and(eq(emailVerifications.id, id), isNull(emailVerifications.usedAt)))
            .returning()
            .then((rows) => rows.at(0))
    },
}
