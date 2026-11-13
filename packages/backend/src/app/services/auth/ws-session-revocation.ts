import { userRepository } from '#app/repositories/index.js'
import {
    wsConnectionRegistry,
    type ListedConnection,
} from '#app/websocket/ws-connection-registry.js'
import websocketConfig from '#config/websocket.js'
import logger from '#vendor/utils/logger.js'
import { endSessionExpired, isClosedSocketError } from '#vendor/utils/network/ws-session-expired.js'
import { sessionExists, sessionsExist } from '#vendor/utils/session/redis-session-storage.js'

// feat-195: a WebSocket message is checked against the session, but a heartbeat is not, and a
// connection that only pings stays open for days. So a session that was revoked (logout,
// logout everywhere, a password change or reset, a claim) kept its sockets, and with them the
// broadcasts: the admin channel, the support replies. Two things close them:
// - the flow that revokes the session closes the user's connections of this instance at once;
// - every instance compares, from the database, the users.session_token each connection was
//   opened with against the current one, and closes those that differ. That covers the
//   connections held by another instance; the delay is bounded by the interval.
//
// feat-210: a logout of one session does not rotate users.session_token, it only deletes the
// stored session. So the same pass also asks Redis whether the session of each connection is
// still stored, and closes the connections of those that are not: a logout handled by another
// instance, or a session that expired while its socket only pinged. And a connection that is
// still being opened when its session is revoked is marked in the registry
// (`revokeConnecting`), because it is not among the connections to close yet.

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
            // feat-210: before the close, so a connection that registers in between is either
            // marked here or found below.
            wsConnectionRegistry.revokeConnecting(userId, sessionId)
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
     * One pass over every connection of this instance. A database or Redis failure throws and
     * changes nothing, the next pass tries again (every message is refused meanwhile by the session
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

        const rotated = (connection: ListedConnection): boolean =>
            connection.userToken === undefined ||
            current.get(connection.userId) !== connection.userToken

        // feat-210: the stored session of every connection whose token is still current.
        const sessions = new Map<string, { sessionId: string; userToken: string }>()
        for (const connection of connections) {
            if (rotated(connection) || connection.userToken === undefined) continue
            sessions.set(`${connection.userToken}:${connection.sessionId}`, {
                sessionId: connection.sessionId,
                userToken: connection.userToken,
            })
        }
        const gone = new Set<string>()
        const keys = [...sessions.keys()]
        const pairs = [...sessions.values()]
        for (let from = 0; from < pairs.length; from += RECHECK_BATCH_SIZE) {
            const stored = await sessionsExist(pairs.slice(from, from + RECHECK_BATCH_SIZE))
            stored.forEach((exists, index) => {
                const key = keys[from + index]
                if (!exists && key !== undefined) gone.add(key)
            })
        }

        const revoked = connections.filter(
            (connection) =>
                rotated(connection) ||
                gone.has(`${String(connection.userToken)}:${connection.sessionId}`),
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

    /** feat-210: whether the session a connection is being opened from is still stored. */
    isSessionStored(sessionId: string, userToken: string): Promise<boolean> {
        return sessionExists(sessionId, userToken)
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
