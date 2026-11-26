import type { SessionAuthState } from 'shared/mfa'
import type { SessionToken } from '#app/domain/secrets.js'

import { adminWsChannelService } from '#app/services/admin/admin-ws-channel-service.js'
import { broadcastService } from '#app/services/communication/broadcast-service.js'
import {
    wsConnectionRegistry,
    type ListedConnection,
} from '#app/websocket/ws-connection-registry.js'
import logger from '#vendor/utils/logger.js'
import { isClosedSocketError } from '#vendor/utils/network/ws-session-expired.js'
import { readStoredSession } from '#vendor/utils/session/redis-session-storage.js'

// feat-247 (docs/plan/passkeys-mfa-plan.md, Р11): the auth state of a session rose (a step-up).
// Its connections carry a copy taken at upgrade; this module refreshes it, and with it the
// admin channel deadline. The instance that handled the step-up applies the state it wrote;
// the others get `session_auth_changed { sessionId }` on the server bus and read the session
// from Redis. A connection the deadline had taken out of the admin channel gets
// `admin_channel_ready`: the client decides whether to subscribe again (as in feat-240).

export interface WsSessionAuthSyncDeps {
    listUserConnections(userId: string): readonly ListedConnection[]
    /** The stored session, or null when it is gone. */
    readSession(
        sessionId: string,
        userToken: SessionToken,
    ): Promise<{ data: { auth?: SessionAuthState } } | null>
}

export interface WsSessionAuthSync {
    /** Applies a known auth state to this instance's connections of the session; how many. */
    apply(userId: string, sessionId: string, auth: SessionAuthState | undefined): number
    /** `session_auth_changed` from another instance: reads the session, then applies. Never throws. */
    refresh(userId: string, sessionId: string): Promise<number>
}

export function createWsSessionAuthSync(deps: WsSessionAuthSyncDeps): WsSessionAuthSync {
    const connectionsOf = (userId: string, sessionId: string): ListedConnection[] =>
        deps.listUserConnections(userId).filter((connection) => connection.sessionId === sessionId)

    const applyTo = (
        connections: readonly ListedConnection[],
        auth: SessionAuthState | undefined,
    ): number => {
        let applied = 0
        for (const { userId, uuid, ws } of connections) {
            try {
                const ready = adminWsChannelService.refreshConnectionAuth(ws, auth)
                applied += 1
                if (ready) {
                    broadcastService.broadcastMessageToUserConnection(
                        userId,
                        uuid,
                        'admin_channel_ready',
                        {},
                    )
                }
            } catch (err) {
                if (isClosedSocketError(err)) continue
                logger.error({ err, userId, socketUuid: uuid }, 'WS session auth not applied')
            }
        }
        return applied
    }

    return {
        apply(userId, sessionId, auth): number {
            return applyTo(connectionsOf(userId, sessionId), auth)
        },

        async refresh(userId, sessionId): Promise<number> {
            const connections = connectionsOf(userId, sessionId)
            if (connections.length === 0) return 0
            // Normally one user token; a rotated one is closed by the session revocation.
            const tokens = new Set(
                connections.flatMap(({ userToken }) =>
                    userToken === undefined ? [] : [userToken],
                ),
            )
            let applied = 0
            for (const userToken of tokens) {
                try {
                    const session = await deps.readSession(sessionId, userToken)
                    // Gone: the revocation closes these connections.
                    if (session === null) continue
                    applied += applyTo(
                        connections.filter((connection) => connection.userToken === userToken),
                        session.data.auth,
                    )
                } catch (err) {
                    logger.warn({ err, userId }, 'WS session auth: the session could not be read')
                }
            }
            return applied
        },
    }
}

export const wsSessionAuthSync = createWsSessionAuthSync({
    listUserConnections: (userId) => wsConnectionRegistry.listUserConnections(userId),
    readSession: readStoredSession,
})
