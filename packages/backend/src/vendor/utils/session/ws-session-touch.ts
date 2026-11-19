import type { UserConnection } from '#vendor/types/types.js'
import logger from '#vendor/utils/logger.js'
import { touchSession } from '#vendor/utils/session/redis-session-storage.js'

/** feat-233 (Р4): a WebSocket connection writes lastSeenAt of its session at most this often. */
export const WS_TOUCH_INTERVAL_MS = 15 * 60_000
const WARN_INTERVAL_MS = 60_000

/**
 * Writes lastSeenAt of the connection's session when the last write is WS_TOUCH_INTERVAL_MS old
 * (or there was none: the socket was just opened). The time moves only after a write succeeded,
 * so after a failure the next message tries again. Never throws; a failure is a warning, at most
 * once a minute per connection.
 */
export const touchSessionFromWs = async (
    userData: UserConnection,
    now = Date.now(),
): Promise<void> => {
    const { sessionId, userToken } = userData
    if (sessionId === undefined || userToken === undefined) return
    if (userData.sessionTouchInFlight === true) return
    const last = userData.sessionTouchedAt
    if (last !== undefined && now - last < WS_TOUCH_INTERVAL_MS) return

    userData.sessionTouchInFlight = true
    try {
        await touchSession(sessionId, userToken, now)
        userData.sessionTouchedAt = now
    } catch (err) {
        const warned = userData.sessionTouchWarnedAt
        if (warned === undefined || now - warned >= WARN_INTERVAL_MS) {
            userData.sessionTouchWarnedAt = now
            logger.warn(
                { err, socketUuid: userData.uuid },
                'lastSeenAt of a WS session not written',
            )
        }
    } finally {
        userData.sessionTouchInFlight = false
    }
}
