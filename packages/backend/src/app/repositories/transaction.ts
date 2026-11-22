import { sql } from 'drizzle-orm'

import { db } from '#database/db.js'

/**
 * What a repository method runs its statements on: the database itself, or the
 * transaction a caller opened with `withTransaction`. A transaction has no `$client`,
 * so only the query builders are required.
 */
export type DbExecutor = Pick<typeof db, 'select' | 'insert' | 'update' | 'delete'>

export type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * Runs `work` in one transaction: it commits when `work` returns and rolls back when
 * it throws. Pass the `tx` it gets to every repository call that must belong to it.
 */
export const withTransaction = <T>(work: (tx: DbTransaction) => Promise<T>): Promise<T> =>
    db.transaction(work)

/**
 * feat-245 (docs/plan/passkeys-mfa-plan.md, Р4): the id of the running transaction, kept to learn
 * later whether it committed when its COMMIT got no answer.
 */
export const currentTransactionId = async (tx: DbTransaction): Promise<string> => {
    const result = await tx.execute<{ xid: string }>(sql`SELECT pg_current_xact_id()::text AS xid`)
    const xid = result.rows[0]?.xid
    if (xid === undefined) throw new Error('no transaction id')
    return xid
}

/**
 * feat-245 (Р4): the fate of a transaction by its id. NULL (PostgreSQL no longer knows) and
 * `in progress` are undetermined, never a rollback.
 */
export const transactionStatus = async (
    xid: string,
): Promise<'committed' | 'aborted' | 'undetermined'> => {
    const result = await db.execute<{ status: string | null }>(
        sql`SELECT pg_xact_status(${xid}::xid8) AS status`,
    )
    const status = result.rows[0]?.status ?? null
    if (status === 'committed') return 'committed'
    if (status === 'aborted') return 'aborted'
    return 'undetermined'
}
