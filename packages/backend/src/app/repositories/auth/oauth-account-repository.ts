import { db } from '#database/db.js'
import { oauthAccounts } from '#database/schema.js'
import { eq, and } from 'drizzle-orm'
import type { DbExecutor } from '../transaction.js'
import type { InferInsertModel, InferSelectModel } from 'drizzle-orm'
import type { OAuthAccountId, UserId } from '#app/domain/ids.js'

export type OAuthAccountRow = InferSelectModel<typeof oauthAccounts>
export type OAuthAccountInsert = InferInsertModel<typeof oauthAccounts>

export interface IOAuthAccountRepository {
    findByProviderAndProviderId(
        provider: string,
        providerUserId: string,
    ): Promise<OAuthAccountRow | undefined>
    findByUserId(userId: UserId, executor?: DbExecutor): Promise<OAuthAccountRow[]>
    /**
     * The link of this identity to this user, read inside `tx` (feat-097): a sign-in
     * re-checks it under the user's row lock, so a claim that removed it is seen.
     */
    findLinkForUser(
        provider: string,
        providerUserId: string,
        userId: UserId,
        tx: DbExecutor,
    ): Promise<OAuthAccountRow | undefined>
    create(data: OAuthAccountInsert, executor?: DbExecutor): Promise<OAuthAccountRow>
    /** Removes every OAuth link of the user (a claim, feat-097). */
    /** Removes every link of the user; answers the provider of each removed link (feat-235). */
    deleteByUserId(userId: UserId, executor: DbExecutor): Promise<string[]>
    /**
     * Removes one link, only if it belongs to this user (feat-199). False when there is no
     * such link of this user: the id of another account's link removes nothing.
     */
    deleteForUser(userId: UserId, id: OAuthAccountId, executor: DbExecutor): Promise<boolean>
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

    async findByUserId(userId, executor = db) {
        return executor.select().from(oauthAccounts).where(eq(oauthAccounts.userId, userId))
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
            .returning({ provider: oauthAccounts.provider })
        return rows.map((row) => row.provider)
    },

    async deleteForUser(userId, id, executor) {
        const rows = await executor
            .delete(oauthAccounts)
            .where(and(eq(oauthAccounts.id, id), eq(oauthAccounts.userId, userId)))
            .returning({ id: oauthAccounts.id })
        return rows.length > 0
    },
}
