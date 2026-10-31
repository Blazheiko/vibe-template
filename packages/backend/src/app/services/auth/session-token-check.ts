import { userRepository } from '#app/repositories/index.js'
import logger from '#logger'
import type { SessionTokenStatus } from '#vendor/utils/session/session-token-check.js'

/**
 * Compares a session's userToken with the user's current sessionToken, read from
 * the database on every call (ADR 0002: no cache, so the answer is never older than
 * the last rotation). A lookup that fails is `unavailable`, never `ok`.
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
