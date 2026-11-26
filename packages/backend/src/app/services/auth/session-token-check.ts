import { userRepository } from '#app/repositories/index.js'
import { parseUserId } from '#app/domain/ids.js'
import logger from '#logger'
import { safeEqual } from '#vendor/utils/helpers/safe-equal.js'
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
    // Text that is not a row id names no user (feat-263): a mismatch, never a lookup.
    const id = parseUserId(userId)
    if (id === null) return 'mismatch'
    try {
        const current = await userRepository.findSessionToken(id)
        if (current === undefined) return 'mismatch'
        return safeEqual(current, userToken) ? 'ok' : 'mismatch'
    } catch (err) {
        logger.error({ err }, 'Session token lookup failed')
        return 'unavailable'
    }
}
