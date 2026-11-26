import { generateKey } from 'metautil'
import redis, { withRedis } from '#database/redis.js'
import { setWithTtlSeconds } from '#app/services/shared/redis-ttl.js'
import type { SessionInfo } from '#vendor/types/types.js'
import configApp from '#config/app.js'
import { isValidEntityId, seconds, type Seconds } from 'shared/brand'

/** How long a WS token can be used to open the socket: once, within a minute. */
const WS_TOKEN_TTL: Seconds = seconds(60)

export async function generateWsToken(sessionInfo: SessionInfo, userId: string): Promise<string> {
    if (!isValidEntityId(userId)) {
        return ''
    }

    const userToken = sessionInfo.data.userToken
    if (userToken === undefined) {
        return ''
    }
    // feat-245 (Р8): a recovery session opens no WebSocket.
    if (sessionInfo.data.auth?.recovery !== undefined) {
        return ''
    }

    const wsToken = generateKey(configApp.characters, 16)
    const tokenData = JSON.stringify({
        sessionId: sessionInfo.id,
        userId,
        userToken,
    })
    await withRedis(() => setWithTtlSeconds(redis, `auth:ws:${wsToken}`, tokenData, WS_TOKEN_TTL))

    return wsToken
}
