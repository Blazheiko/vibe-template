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
