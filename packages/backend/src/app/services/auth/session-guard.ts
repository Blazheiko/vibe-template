import { Result } from 'better-result'
import { userRepository, withTransaction } from '#app/repositories/index.js'
import type { DbTransaction, UserRow } from '#app/repositories/index.js'
import { sessionRevoked, type AppResult } from '#app/services/shared/errors.js'
import { safeEqual } from '#vendor/utils/helpers/safe-equal.js'

/**
 * Runs `work` in one transaction under the user's row lock, and only while the session
 * token the request presented is still the account's (feat-098). A claim takes the same
 * lock and rotates the token (ADR 0002): a request admitted before the claim either
 * commits first (and the claim then removes what it wrote) or sees the new token here and
 * answers 401 `session_revoked`. Use it for writes a claim must be able to undo that are
 * not a single `updateIfSessionToken` statement, such as inserts into other tables.
 */
export async function withCurrentSession<T>(
    userId: bigint,
    presentedSessionToken: string | undefined,
    work: (tx: DbTransaction, user: UserRow) => Promise<AppResult<T>>,
): Promise<AppResult<T>> {
    if (presentedSessionToken === undefined) return Result.err(sessionRevoked())
    return await withTransaction(async (tx) => {
        const user = await userRepository.lockById(userId, tx)
        if (user === undefined || !safeEqual(user.sessionToken, presentedSessionToken)) {
            return Result.err(sessionRevoked())
        }
        return await work(tx, user)
    })
}
