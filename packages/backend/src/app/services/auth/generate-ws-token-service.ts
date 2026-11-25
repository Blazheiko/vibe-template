import { generateKey } from 'metautil'
import redis, { withRedis } from '#database/redis.js'
import type { SessionInfo } from '#vendor/types/types.js'
import configApp from '#config/app.js'
import { isValidEntityId } from 'shared/brand'

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
    await withRedis(() => redis.setex(`auth:ws:${wsToken}`, 60, tokenData))

    return wsToken
}
