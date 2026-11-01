import { db } from '#database/db.js'
import type { DbExecutor } from '../transaction.js'
import type {
    emailLinkVerifications,
    emailVerifications,
    passwordResetTokens,
} from '#database/schema.js'
import { and, eq, isNull, type InferInsertModel, type InferSelectModel } from 'drizzle-orm'

/**
 * The three one-time-token tables (password reset, e-mail verification, e-mail linking) have the
 * same columns for what a token is: id, user, hash of the secret, expiry and the instant it was
 * used. They stay three tables (merging them would be a migration for no gain); what they have
 * in common is this repository.
 */
export type TokenTable =
    typeof passwordResetTokens | typeof emailVerifications | typeof emailLinkVerifications

export interface ITokenRepository<TRow, TInsert> {
    create(data: TInsert): Promise<TRow>
    findByTokenHash(tokenHash: string): Promise<TRow | undefined>
    invalidatePendingByUserId(userId: bigint): Promise<number>
    /**
     * Claims the token: `used_at` is set only if it is still NULL, so of two concurrent
     * requests with one token exactly one gets the row back. Undefined: already used.
     * Pass the transaction in which the token's effect is applied.
     */
    markUsed(id: bigint, usedAt?: Date, executor?: DbExecutor): Promise<TRow | undefined>
}

/**
 * `createFailure` is the text of the error thrown when an insert returns no row.
 */
export function createTokenRepository<T extends TokenTable>(
    table: T,
    createFailure: string,
): ITokenRepository<InferSelectModel<T>, InferInsertModel<T>> {
    // The columns used below exist, with the same types, on all three tables; drizzle cannot
    // resolve a union of tables, so the factory looks at them as one. The types of what comes
    // out are those of the table that went in.
    const t = table as unknown as typeof passwordResetTokens
    type Row = InferSelectModel<T>

    return {
        async create(data): Promise<Row> {
            const [created] = await db
                .insert(t)
                .values(data as InferInsertModel<typeof passwordResetTokens>)
                .returning()
            if (created === undefined) {
                throw new Error(createFailure)
            }

            return created as Row
        },

        async findByTokenHash(tokenHash): Promise<Row | undefined> {
            return await db
                .select()
                .from(t)
                .where(eq(t.tokenHash, tokenHash))
                .limit(1)
                .then((rows) => rows.at(0) as Row | undefined)
        },

        async invalidatePendingByUserId(userId): Promise<number> {
            const result = await db
                .update(t)
                .set({ usedAt: new Date() })
                .where(and(eq(t.userId, userId), isNull(t.usedAt)))
                .returning({ id: t.id })

            return result.length
        },

        async markUsed(id, usedAt = new Date(), executor = db): Promise<Row | undefined> {
            return await executor
                .update(t)
                .set({ usedAt })
                .where(and(eq(t.id, id), isNull(t.usedAt)))
                .returning()
                .then((rows) => rows.at(0) as Row | undefined)
        },
    }
}
