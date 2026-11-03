import { db } from '#database/db.js'
import type { DbExecutor } from '../transaction.js'
import type {
    emailLinkVerifications,
    emailVerifications,
    passwordResetTokens,
} from '#database/schema.js'
import { and, eq, gt, isNull, sql, type InferInsertModel, type InferSelectModel } from 'drizzle-orm'

/**
 * The three one-time-token tables (password reset, e-mail verification, e-mail linking) have the
 * same columns for what a token is: id, user, hash of the secret, expiry and the instant it was
 * used. They stay three tables (merging them would be a migration for no gain); what they have
 * in common is this repository.
 */
export type TokenTable =
    typeof passwordResetTokens | typeof emailVerifications | typeof emailLinkVerifications

// The wall clock at the moment the statement runs. `now()` is fixed when the transaction
// starts, so a token that expired while the transaction waited for the user lock would
// still pass `expires_at > now()` (feat-096). The columns are `timestamp` without time
// zone holding UTC (drizzle writes Date.toISOString()), hence the explicit conversion.
const statementTime = sql`(clock_timestamp() AT TIME ZONE 'UTC')`

export interface ITokenRepository<TRow, TInsert> {
    create(data: TInsert, executor?: DbExecutor): Promise<TRow>
    findByTokenHash(tokenHash: string): Promise<TRow | undefined>
    /**
     * Retires every pending token of the user in this table. No exception by id: ids of
     * different tables are unrelated, and a consumed token is no longer pending anyway.
     */
    invalidatePendingByUserId(userId: bigint, executor?: DbExecutor): Promise<number>
    /**
     * Claims the token: `used_at` is set only if it is still NULL and the token has not
     * expired at this instant (`clock_timestamp()`), so of two concurrent requests with one
     * token exactly one gets the row back. Undefined: used or expired. Pass the transaction
     * in which the token's effect is applied.
     */
    markUsed(id: bigint, executor?: DbExecutor): Promise<TRow | undefined>
    /** Marks an expired token used, so it is gone for good. No expiry condition. */
    burn(id: bigint): Promise<void>
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
        async create(data, executor = db): Promise<Row> {
            const [created] = await executor
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

        async invalidatePendingByUserId(userId, executor = db): Promise<number> {
            const result = await executor
                .update(t)
                .set({ usedAt: statementTime })
                .where(and(eq(t.userId, userId), isNull(t.usedAt)))
                .returning({ id: t.id })

            return result.length
        },

        async markUsed(id, executor = db): Promise<Row | undefined> {
            return await executor
                .update(t)
                .set({ usedAt: statementTime })
                .where(and(eq(t.id, id), isNull(t.usedAt), gt(t.expiresAt, statementTime)))
                .returning()
                .then((rows) => rows.at(0) as Row | undefined)
        },

        async burn(id): Promise<void> {
            await db
                .update(t)
                .set({ usedAt: statementTime })
                .where(and(eq(t.id, id), isNull(t.usedAt)))
        },
    }
}
