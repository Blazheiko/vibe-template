import { db } from '#database/db.js'
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core'
import { count, inArray, lt } from 'drizzle-orm'

/**
 * feat-223: deletes rows whose `expires_at` has passed, for the auth-token-cleanup job. The five
 * auth tables that expire (four one-time-token tables and the SMS challenges) each expose these
 * two methods; every one has an index on `expires_at`.
 */
export interface ExpiredRowsRepository {
    /**
     * Deletes up to `limit` rows with `expires_at < before`, lowest id first, and returns how
     * many it deleted. Two concurrent calls never delete a row twice and do not fail: a row the
     * other one deleted first is skipped, so a batch may come back short.
     */
    deleteExpiredBatch(before: Date, limit: number): Promise<number>
    /** How many rows have `expires_at < before` (the dry run). */
    countExpired(before: Date): Promise<number>
}

/** The columns the two queries need: the primary key and the expiry. */
export function expiredRowsRepository(
    table: PgTable,
    columns: { id: AnyPgColumn; expiresAt: AnyPgColumn },
): ExpiredRowsRepository {
    return {
        async deleteExpiredBatch(before, limit): Promise<number> {
            const batch = db
                .select({ id: columns.id })
                .from(table)
                .where(lt(columns.expiresAt, before))
                .orderBy(columns.id)
                .limit(limit)
            const deleted = await db
                .delete(table)
                .where(inArray(columns.id, batch))
                .returning({ id: columns.id })
            return deleted.length
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
