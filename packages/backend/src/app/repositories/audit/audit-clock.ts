import { sql } from 'drizzle-orm'

import type { DbTransaction } from '#app/repositories/transaction.js'

/**
 * The wall clock of the database server, read in the transaction (feat-235, Р3): unlike now(), it
 * is not the start of the transaction, so a stamp taken after a row lock orders the changes of
 * that row as they were applied. Text in UTC (every pool runs with TimeZone=UTC), with its
 * microseconds.
 */
export async function readClockTimestamp(tx: DbTransaction): Promise<string> {
    const result = await tx.execute<{ t: string }>(
        sql`SELECT clock_timestamp()::timestamp(6)::text AS t`,
    )
    const value = result.rows[0]?.t
    if (value === undefined) throw new Error('clock_timestamp() returned no row')
    return value
}
