import redis, { withRedis } from '#database/redis.js'
import logger from '#logger'
import { maskTokenForLogs } from '#vendor/utils/helpers/mask-sensitive.js'
import type { SessionInfo, SessionData } from '#vendor/types/types.js'
import type { UpgradeTokenResult } from '#vendor/utils/network/ws-handlers.js'
import { RedisUnavailableError } from '#vendor/utils/network/errors/redis-unavailable-error.js'
import { checkSessionToken } from '#app/services/auth/session-token-check.js'
import { isPastMaxAge } from '#vendor/utils/session/session-age.js'

const MISSING: UpgradeTokenResult = { kind: 'missing' }

/**
 * The token is consumed whatever the answer: a refused upgrade asks for a new one.
 * `unavailable` when Redis is down: the first failed command stops the check,
 * the session lookup is not attempted, and the upgrade is answered with 503. The same
 * answer when the sessionToken lookup (database) fails: no access on the Redis
 * record alone.
 */
const verifyUpgradeToken = async (token: string): Promise<UpgradeTokenResult> => {
    if (token === '') return MISSING
    try {
        // feat-196: read and deleted in one command, so a token opens one connection. Whoever
        // saw it (it travels in Sec-WebSocket-Protocol) cannot open another with it, and of two
        // upgrades racing with one token exactly one gets the record.
        const tokenData = await withRedis(() => redis.getdel(`auth:ws:${token}`))
        if (tokenData === null) {
            logger.warn(
                { token: maskTokenForLogs(token) },
                'verifyUpgradeToken: token not found in Redis',
            )
            return MISSING
        }

        const parsed = JSON.parse(tokenData) as {
            sessionId: string | undefined
            userId: string | undefined
            userToken: string | undefined
        }
        const { sessionId, userId, userToken } = parsed

        if (
            sessionId === undefined ||
            userId === undefined ||
            userToken === undefined ||
            userId === '' ||
            userToken === '' ||
            sessionId === ''
        ) {
            logger.warn({ sessionId, userId }, 'verifyUpgradeToken: invalid token data')
            return MISSING
        }

        const sessionKey = `session:${userToken}:${sessionId}`
        const sessionData = await withRedis(() => redis.get(sessionKey))
        if (sessionData === null) {
            logger.warn(
                { sessionId, userToken: maskTokenForLogs(userToken) },
                'verifyUpgradeToken: session not found in Redis',
            )
            return MISSING
        }

        const sessionInfo = JSON.parse(sessionData) as SessionInfo
        // feat-119 (F1): the same lifetime as an HTTP request: a session past
        // SESSION_MAX_AGE_DAYS opens no WebSocket, and its record is deleted.
        if (isPastMaxAge(sessionInfo.createdAt)) {
            logger.warn(
                { sessionId, userToken: maskTokenForLogs(userToken) },
                'verifyUpgradeToken: session past its maximum age',
            )
            try {
                await withRedis(() => redis.del(sessionKey))
            } catch (err: unknown) {
                logger.warn({ err }, 'verifyUpgradeToken: could not delete an expired session')
            }
            return MISSING
        }
        const data: SessionData = sessionInfo.data
        if ('userId' in data && data.userId === userId) {
            // ADR 0002: a rotated sessionToken revokes the session even though its
            // Redis record is still there.
            const tokenStatus = await checkSessionToken(userId, userToken)
            if (tokenStatus === 'unavailable') return { kind: 'unavailable' }
            if (tokenStatus === 'mismatch') {
                logger.warn(
                    { sessionId, userToken: maskTokenForLogs(userToken) },
                    'verifyUpgradeToken: session revoked (sessionToken rotated)',
                )
                return MISSING
            }
            return { kind: 'ok', sessionId, userId, userToken }
        }

        logger.warn(
            { sessionUserId: data.userId, tokenUserId: userId },
            'verifyUpgradeToken: userId mismatch between session and token',
        )
        return MISSING
    } catch (error) {
        if (error instanceof RedisUnavailableError) return { kind: 'unavailable' }
        logger.error({ err: error }, 'verifyUpgradeToken error')
        return MISSING
    }
}

export const wsSessionAuth = {
    verifyUpgradeToken,
}
