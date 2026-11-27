import { userRepository } from '#app/repositories/index.js'
import { parseUserId, type UserId } from '#app/domain/ids.js'
import { sessionTokenOf, type SessionToken } from '#app/domain/secrets.js'
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
    userId: UserId,
    userToken: SessionToken,
): Promise<SessionTokenStatus> => {
    try {
        const current = await userRepository.findSessionToken(userId)
        if (current === undefined) return 'mismatch'
        return safeEqual(current, userToken) ? 'ok' : 'mismatch'
    } catch (err) {
        logger.error({ err }, 'Session token lookup failed')
        return 'unavailable'
    }
}

/**
 * feat-272: the hook the session layer calls (registered in app/start). The vendor layer holds the
 * session record as text (Р13), so the ids are read here once: text that is not a row id names
 * no user (feat-263), a mismatch and no lookup. Inside the app, checkSessionToken takes the
 * brands, so the user id and the token cannot be swapped.
 */
export const checkSessionTokenText = (
    userId: string,
    userToken: string,
): Promise<SessionTokenStatus> => {
    const id = parseUserId(userId)
    if (id === null) return Promise.resolve('mismatch')
    return checkSessionToken(id, sessionTokenOf(userToken))
}
