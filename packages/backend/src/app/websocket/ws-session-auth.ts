import redis, { withRedis } from '#database/redis.js'
import logger from '#logger'
import { maskTokenForLogs } from '#vendor/utils/helpers/mask-sensitive.js'
import type { SessionInfo, SessionData } from '#vendor/types/types.js'
import type { UpgradeTokenResult } from '#vendor/utils/network/ws-handlers.js'
import { RedisUnavailableError } from '#vendor/utils/network/errors/redis-unavailable-error.js'
import { checkSessionToken } from '#app/services/auth/session-token-check.js'

const WS_TOKEN_TTL = 120

const MISSING: UpgradeTokenResult = { kind: 'missing' }

/**
 * `unavailable` when Redis is down: the first failed command stops the check,
 * the session lookup is not attempted, and the upgrade is answered with 503. The same
 * answer when the sessionToken lookup (database) fails: no access on the Redis
 * record alone.
 */
const verifyUpgradeToken = async (token: string): Promise<UpgradeTokenResult> => {
    if (token === '') return MISSING
    try {
        const tokenData = await withRedis(() => redis.get(`auth:ws:${token}`))
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

const refreshToken = async (token: string): Promise<void> => {
    if (token === '') return
    await withRedis(() => redis.expire(`auth:ws:${token}`, WS_TOKEN_TTL))
}

const revokeToken = async (token: string): Promise<void> => {
    if (token === '') return
    await withRedis(() => redis.del(`auth:ws:${token}`))
}

export const wsSessionAuth = {
    verifyUpgradeToken,
    refreshToken,
    revokeToken,
}
