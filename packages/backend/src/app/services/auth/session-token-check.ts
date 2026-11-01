import { userRepository } from '#app/repositories/index.js'
import sessionConfig from '#config/session.js'
import logger from '#logger'
import type { SessionTokenStatus } from '#vendor/utils/session/session-token-check.js'

const TIMED_OUT = Symbol('session token lookup timed out')

/**
 * Compares a session's userToken with the user's current sessionToken, read from
 * the database on every call (ADR 0002: no cache, so the answer is never older than
 * the last rotation). A lookup that fails or does not answer within
 * SESSION_TOKEN_CHECK_TIMEOUT_MS is `unavailable`, never `ok`.
 *
 * On a timeout the query is abandoned, not cancelled: it holds its pooled connection
 * until the database answers or the connection drops. The pool's own
 * connectionTimeoutMillis then makes the next checks fail fast as `unavailable`, so
 * requests end in a 503 instead of queueing behind a stuck database. The client
 * disconnecting is not passed down: the deadline already bounds the wait.
 */
export const checkSessionToken = async (
    userId: string,
    userToken: string,
): Promise<SessionTokenStatus> => {
    if (!/^[1-9]\d*$/.test(userId)) return 'mismatch'
    let timer: NodeJS.Timeout | undefined
    try {
        // Promise.race handles the lookup's late rejection too: no unhandled rejection.
        const current = await Promise.race([
            userRepository.findSessionToken(BigInt(userId)),
            new Promise<typeof TIMED_OUT>((resolve) => {
                timer = setTimeout(() => {
                    resolve(TIMED_OUT)
                }, sessionConfig.tokenCheckTimeoutMs)
            }),
        ])
        if (current === TIMED_OUT) {
            logger.error(
                { timeoutMs: sessionConfig.tokenCheckTimeoutMs },
                'Session token lookup timed out',
            )
            return 'unavailable'
        }
        if (current === undefined) return 'mismatch'
        return current === userToken ? 'ok' : 'mismatch'
    } catch (err) {
        logger.error({ err }, 'Session token lookup failed')
        return 'unavailable'
    } finally {
        clearTimeout(timer)
    }
}
