import { db } from '#database/db.js'
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core'
import { count, lt, sql, type SQL } from 'drizzle-orm'

/**
 * feat-223: deletes rows whose `expires_at` has passed, for the auth-token-cleanup job. The five
 * auth tables that expire (four one-time-token tables and the SMS challenges) each expose these
 * two methods; every one has an index on `expires_at`.
 */
export interface ExpiredRowsRepository {
    /**
     * Deletes up to `limit` rows with `expires_at < before`, oldest expiry first, and returns how
     * many it deleted. Two concurrent calls never delete a row twice and do not fail: a row the
     * other one deleted first is skipped, so a batch may come back short.
     */
    deleteExpiredBatch(before: Date, limit: number): Promise<number>
    /** How many rows have `expires_at < before` (the dry run). */
    countExpired(before: Date): Promise<number>
}

interface ExpiryColumns {
    id: AnyPgColumn
    expiresAt: AnyPgColumn
}

/**
 * The statement `deleteExpiredBatch` runs (exported for the plan test). The batch is picked by
 * walking the `expires_at` index, so a batch reads at most `limit` index entries however many
 * other rows the table has. `= ANY(ARRAY(…))` evaluates the batch once and deletes by primary
 * key; `IN (…)` with `ORDER BY id` let the planner sort every expired row for each batch.
 */
export function expiredBatchDelete(
    table: PgTable,
    columns: ExpiryColumns,
    before: Date,
    limit: number,
): SQL {
    const batch = db
        .select({ id: columns.id })
        .from(table)
        .where(lt(columns.expiresAt, before))
        .orderBy(columns.expiresAt)
        .limit(limit)
    return sql`delete from ${table} where ${columns.id} = any(array(${batch})) returning ${columns.id}`
}

/** The columns the two queries need: the primary key and the expiry. */
export function expiredRowsRepository(
    table: PgTable,
    columns: ExpiryColumns,
): ExpiredRowsRepository {
    return {
        async deleteExpiredBatch(before, limit): Promise<number> {
            const result = await db.execute<{ id: unknown }>(
                expiredBatchDelete(table, columns, before, limit),
            )
            return result.rows.length
        },

        async countExpired(before): Promise<number> {
            const [row] = await db
                .select({ total: count() })
                .from(table)
                .where(lt(columns.expiresAt, before))
            return row?.total ?? 0
        },
    }
}
