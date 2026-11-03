import { Result } from 'better-result'

import { withTransaction, type DbTransaction } from '#app/repositories/index.js'
import type { AppResult } from './errors.js'

// withTransaction commits when its work returns, whatever it returns, and rolls back only on a
// throw. A business refusal found half way (a check on a locked row) comes back as Result.err, and
// committing the statements before it would be wrong; here it rolls them back too.

class RollbackForResult extends Error {
    constructor(readonly result: AppResult<never>) {
        super('Transaction rolled back for an error result')
        this.name = 'RollbackForResult'
    }
}

/** Runs `work` in one transaction that commits on Result.ok and rolls back on Result.err or a throw. */
export async function withTransactionResult<T>(
    work: (tx: DbTransaction) => Promise<AppResult<T>>,
): Promise<AppResult<T>> {
    try {
        return await withTransaction(async (tx) => {
            const result = await work(tx)
            if (Result.isError(result)) throw new RollbackForResult(Result.err(result.error))
            return result
        })
    } catch (err: unknown) {
        if (err instanceof RollbackForResult) return err.result
        throw err
    }
}
