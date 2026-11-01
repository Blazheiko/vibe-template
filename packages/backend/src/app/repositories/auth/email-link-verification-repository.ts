import { db } from '#database/db.js'
import type { DbExecutor } from '../transaction.js'
import { emailLinkVerifications } from '#database/schema.js'
import { and, eq, isNull, type InferInsertModel, type InferSelectModel } from 'drizzle-orm'

export type EmailLinkVerificationRow = InferSelectModel<typeof emailLinkVerifications>
export type EmailLinkVerificationInsert = InferInsertModel<typeof emailLinkVerifications>

export interface IEmailLinkVerificationRepository {
    create(data: EmailLinkVerificationInsert): Promise<EmailLinkVerificationRow>
    findByTokenHash(tokenHash: string): Promise<EmailLinkVerificationRow | undefined>
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
    ): Promise<EmailLinkVerificationRow | undefined>
}

export const emailLinkVerificationRepository: IEmailLinkVerificationRepository = {
    async create(data) {
        const [created] = await db.insert(emailLinkVerifications).values(data).returning()
        if (created === undefined) {
            throw new Error('Failed to create email link verification')
        }

        return created
    },

    async findByTokenHash(tokenHash) {
        return await db
            .select()
            .from(emailLinkVerifications)
            .where(eq(emailLinkVerifications.tokenHash, tokenHash))
            .limit(1)
            .then((rows) => rows.at(0))
    },

    async invalidatePendingByUserId(userId) {
        const result = await db
            .update(emailLinkVerifications)
            .set({ usedAt: new Date() })
            .where(
                and(
                    eq(emailLinkVerifications.userId, userId),
                    isNull(emailLinkVerifications.usedAt),
                ),
            )
            .returning({ id: emailLinkVerifications.id })

        return result.length
    },

    async markUsed(id, usedAt = new Date(), executor = db) {
        return await executor
            .update(emailLinkVerifications)
            .set({ usedAt })
            .where(and(eq(emailLinkVerifications.id, id), isNull(emailLinkVerifications.usedAt)))
            .returning()
            .then((rows) => rows.at(0))
    },
}
