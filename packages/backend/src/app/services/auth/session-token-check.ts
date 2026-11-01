import { userRepository } from '#app/repositories/index.js'
import logger from '#logger'
import type { SessionTokenStatus } from '#vendor/utils/session/session-token-check.js'

/**
 * Compares a session's userToken with the user's current sessionToken, read from
 * the database on every call (ADR 0002: no cache, so the answer is never older than
 * the last rotation). A lookup that fails is `unavailable`, never `ok`.
 *
 * There is no deadline here: the lookup runs on the session-check pool
 * (database/session-check-db.ts), whose statement_timeout makes the server cancel a
 * stuck statement, and whose query_timeout ends the wait on a server that does not
 * answer at all. Either way the pool rejects, and that is `unavailable` (503).
 */
export const checkSessionToken = async (
    userId: string,
    userToken: string,
): Promise<SessionTokenStatus> => {
    if (!/^[1-9]\d*$/.test(userId)) return 'mismatch'
    try {
        const current = await userRepository.findSessionToken(BigInt(userId))
        if (current === undefined) return 'mismatch'
        return current === userToken ? 'ok' : 'mismatch'
    } catch (err) {
        logger.error({ err }, 'Session token lookup failed')
        return 'unavailable'
    }
}
