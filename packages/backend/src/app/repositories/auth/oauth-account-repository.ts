import { db } from '#database/db.js'
import { oauthAccounts } from '#database/schema.js'
import { eq, and } from 'drizzle-orm'
import type { DbExecutor } from '../transaction.js'
import type { InferInsertModel, InferSelectModel } from 'drizzle-orm'

export type OAuthAccountRow = InferSelectModel<typeof oauthAccounts>
export type OAuthAccountInsert = InferInsertModel<typeof oauthAccounts>

export interface IOAuthAccountRepository {
    findByProviderAndProviderId(
        provider: string,
        providerUserId: string,
    ): Promise<OAuthAccountRow | undefined>
    findByUserId(userId: bigint): Promise<OAuthAccountRow[]>
    /**
     * The link of this identity to this user, read inside `tx` (feat-097): a sign-in
     * re-checks it under the user's row lock, so a claim that removed it is seen.
     */
    findLinkForUser(
        provider: string,
        providerUserId: string,
        userId: bigint,
        tx: DbExecutor,
    ): Promise<OAuthAccountRow | undefined>
    create(data: OAuthAccountInsert, executor?: DbExecutor): Promise<OAuthAccountRow>
    /** Removes every OAuth link of the user (a claim, feat-097). */
    deleteByUserId(userId: bigint, executor: DbExecutor): Promise<number>
}

export const oauthAccountRepository: IOAuthAccountRepository = {
    async findByProviderAndProviderId(provider, providerUserId) {
        return db
            .select()
            .from(oauthAccounts)
            .where(
                and(
                    eq(oauthAccounts.provider, provider),
                    eq(oauthAccounts.providerUserId, providerUserId),
                ),
            )
            .limit(1)
            .then((rows) => rows.at(0))
    },

    async findByUserId(userId) {
        return db.select().from(oauthAccounts).where(eq(oauthAccounts.userId, userId))
    },

    async findLinkForUser(provider, providerUserId, userId, tx) {
        return tx
            .select()
            .from(oauthAccounts)
            .where(
                and(
                    eq(oauthAccounts.provider, provider),
                    eq(oauthAccounts.providerUserId, providerUserId),
                    eq(oauthAccounts.userId, userId),
                ),
            )
            .limit(1)
            .then((rows) => rows.at(0))
    },

    async create(data, executor = db) {
        const now = new Date()
        const [created] = await executor
            .insert(oauthAccounts)
            .values({
                ...data,
                createdAt: now,
                updatedAt: now,
            })
            .returning()
        if (created === undefined) {
            throw new Error('Failed to create oauth account')
        }
        return created
    },

    async deleteByUserId(userId, executor) {
        const rows = await executor
            .delete(oauthAccounts)
            .where(eq(oauthAccounts.userId, userId))
            .returning({ id: oauthAccounts.id })
        return rows.length
    },
}
