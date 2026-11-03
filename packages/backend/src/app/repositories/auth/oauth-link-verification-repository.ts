import { db } from '#database/db.js'
import { oauthLinkVerifications } from '#database/schema.js'
import { and, eq, isNull, sql, type InferInsertModel, type InferSelectModel } from 'drizzle-orm'
import type { DbExecutor } from '../transaction.js'
import { createTokenRepository, type ITokenRepository } from './token-repository.js'

export type OAuthLinkVerificationRow = InferSelectModel<typeof oauthLinkVerifications>
export type OAuthLinkVerificationInsert = InferInsertModel<typeof oauthLinkVerifications>

export interface IOAuthLinkVerificationRepository extends ITokenRepository<
    OAuthLinkVerificationRow,
    OAuthLinkVerificationInsert
> {
    /**
     * Retires the user's pending links of one provider only: a pending GitHub link does not
     * cancel a pending GitLab one (feat-097).
     */
    invalidatePendingByUserIdAndProvider(
        userId: bigint,
        provider: string,
        executor?: DbExecutor,
    ): Promise<number>
}

const base = createTokenRepository(
    oauthLinkVerifications,
    'Failed to create OAuth link verification',
)

export const oauthLinkVerificationRepository: IOAuthLinkVerificationRepository = {
    ...base,

    async invalidatePendingByUserIdAndProvider(userId, provider, executor = db) {
        const rows = await executor
            .update(oauthLinkVerifications)
            .set({ usedAt: sql`(clock_timestamp() AT TIME ZONE 'UTC')` })
            .where(
                and(
                    eq(oauthLinkVerifications.userId, userId),
                    eq(oauthLinkVerifications.provider, provider),
                    isNull(oauthLinkVerifications.usedAt),
                ),
            )
            .returning({ id: oauthLinkVerifications.id })
        return rows.length
    },
}
