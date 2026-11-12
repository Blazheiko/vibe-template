import { userRepository } from '#app/repositories/index.js'
import {
    wsConnectionRegistry,
    type ListedConnection,
} from '#app/websocket/ws-connection-registry.js'
import websocketConfig from '#config/websocket.js'
import logger from '#vendor/utils/logger.js'
import { endSessionExpired, isClosedSocketError } from '#vendor/utils/network/ws-session-expired.js'

// feat-195: a WebSocket message is checked against the session, but a heartbeat is not, and a
// connection that only pings stays open for days. So a session that was revoked (logout,
// logout everywhere, a password change or reset, a claim) kept its sockets, and with them the
// broadcasts: the admin channel, the support replies. Two things close them:
// - the flow that revokes the session closes the user's connections of this instance at once;
// - every instance compares, from the database, the users.session_token each connection was
//   opened with against the current one, and closes those that differ. That covers the
//   connections held by another instance; the delay is bounded by the interval.

export interface SessionRecheckReport {
    checked: number
    closed: number
    /** Connections that should have been closed but could not be; the next pass retries. */
    failed: number
}

// One statement per this many users, so the id list of a pass stays bounded.
const RECHECK_BATCH_SIZE = 1000

/** True when the connection was closed here, false when it had closed already. */
const closeConnection = (connection: ListedConnection): boolean => {
    try {
        endSessionExpired(connection.ws)
        return true
    } catch (err) {
        // Closed meanwhile: there is nothing left to close.
        if (isClosedSocketError(err)) return false
        throw err
    }
}

const closeAll = (
    connections: ListedConnection[],
    reason: string,
): { closed: number; failed: number } => {
    let closed = 0
    let failed = 0
    for (const connection of connections) {
        try {
            if (closeConnection(connection)) closed += 1
        } catch (err) {
            // One broken connection must not keep the others open.
            failed += 1
            logger.error(
                { err, userId: connection.userId, socketUuid: connection.uuid },
                'WS connection of a revoked session could not be closed',
            )
        }
    }
    if (closed > 0) {
        logger.info({ userId: connections[0]?.userId, closed, reason }, 'WS connections closed')
    }
    return { closed, failed }
}

let timer: NodeJS.Timeout | undefined
let running = false

export const wsSessionRevocation = {
    /**
     * Closes, with 4001, the connections this instance holds for the user: all of them, or
     * only those opened from `sessionId` (a logout of one session). Never throws: the session
     * is revoked already, and a connection that could not be closed is left to the re-check.
     */
    closeUserConnections(userId: string, options: { sessionId?: string } = {}): number {
        try {
            const { sessionId } = options
            const connections = wsConnectionRegistry
                .listUserConnections(userId)
                .filter(
                    (connection) => sessionId === undefined || connection.sessionId === sessionId,
                )
            return closeAll(connections, sessionId === undefined ? 'revoked' : 'logout').closed
        } catch (err) {
            logger.error({ err, userId }, 'WS connections of a revoked session not closed')
            return 0
        }
    },

    /**
     * One pass over every connection of this instance. A database failure throws and changes
     * nothing, the next pass tries again (every message is refused meanwhile by the session
     * check). A user that no longer exists has no session at all.
     */
    async recheckSessions(): Promise<SessionRecheckReport> {
        const connections = wsConnectionRegistry.listConnections()
        if (connections.length === 0) return { checked: 0, closed: 0, failed: 0 }

        const userIds = [...new Set(connections.map((connection) => connection.userId))]
        const current = new Map<string, string>()
        for (let from = 0; from < userIds.length; from += RECHECK_BATCH_SIZE) {
            const batch = userIds.slice(from, from + RECHECK_BATCH_SIZE)
            const tokens = await userRepository.findSessionTokensByIds(
                batch.map((id) => BigInt(id)),
            )
            for (const [id, token] of tokens) current.set(id, token)
        }

        const revoked = connections.filter(
            (connection) =>
                connection.userToken === undefined ||
                current.get(connection.userId) !== connection.userToken,
        )
        let closed = 0
        let failed = 0
        for (const connection of revoked) {
            const result = closeAll([connection], 're-check')
            closed += result.closed
            failed += result.failed
        }
        return { checked: connections.length, closed, failed }
    },

    start(intervalMs: number = websocketConfig.sessionRecheckIntervalMs): void {
        if (timer !== undefined) return
        timer = setInterval(() => {
            // A slow database must not stack passes.
            if (running) return
            running = true
            wsSessionRevocation
                .recheckSessions()
                .catch((err: unknown) => {
                    logger.error({ err }, 'WS session re-check failed')
                })
                .finally(() => {
                    running = false
                })
        }, intervalMs)
        timer.unref()
    },

    stop(): void {
        if (timer === undefined) return
        clearInterval(timer)
        timer = undefined
    },
}
