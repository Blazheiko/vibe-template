import { userRepository } from '#app/repositories/index.js'
import { adminWsChannelService } from '#app/services/admin/admin-ws-channel-service.js'
import { wsConnectionRegistry } from '#app/websocket/ws-connection-registry.js'
import websocketConfig from '#config/websocket.js'
import logger from '#vendor/utils/logger.js'

// feat-062: the role of a WebSocket connection is read once, when it is opened, and the
// admin channel is subscribed once. A connection can stay open for days (pings keep it
// alive), so an admin demoted in the database would keep receiving the admin broadcasts
// without sending a single request. Nothing in the application changes users.role, so
// there is no event to react to: every instance re-reads, from the database, the role of
// the connections it holds that are admin ones, and takes the admin access away from
// those whose role is no longer `admin`. The delay is bounded by the interval.

export interface AdminRecheckReport {
    checked: number
    revoked: number
}

const isAdminConnection = (
    ws: ReturnType<typeof wsConnectionRegistry.listConnections>[number]['ws'],
): boolean => {
    try {
        return ws.getUserData().role === 'admin'
    } catch {
        // Closed between the snapshot and now.
        return false
    }
}

let timer: NodeJS.Timeout | undefined
let running = false

export const adminWsAccessService = {
    /**
     * One pass: a single query for the roles of every user that holds an admin
     * connection on this instance. A database failure throws and changes nothing, the
     * next pass tries again (while the database cannot answer, a demotion cannot be
     * observed; every WebSocket message is refused meanwhile by the session check).
     */
    async recheckAdminConnections(): Promise<AdminRecheckReport> {
        const adminConnections = wsConnectionRegistry
            .listConnections()
            .filter((connection) => isAdminConnection(connection.ws))
        if (adminConnections.length === 0) return { checked: 0, revoked: 0 }

        const userIds = [...new Set(adminConnections.map((connection) => connection.userId))]
        const roles = await userRepository.findRolesByIds(userIds.map((id) => BigInt(id)))

        let revoked = 0
        for (const { userId, uuid, ws } of adminConnections) {
            // A user that no longer exists has no role at all.
            if (roles.get(userId) === 'admin') continue
            try {
                adminWsChannelService.revokeAdminAccess(ws)
            } catch {
                // Closed while the query ran: nothing left to revoke.
                continue
            }
            revoked += 1
            logger.warn(
                { userId, socketUuid: uuid },
                'WS admin access revoked: the role is no longer admin',
            )
        }
        return { checked: adminConnections.length, revoked }
    },

    start(intervalMs: number = websocketConfig.adminRecheckIntervalMs): void {
        if (timer !== undefined) return
        timer = setInterval(() => {
            // A slow database must not stack passes.
            if (running) return
            running = true
            adminWsAccessService
                .recheckAdminConnections()
                .catch((err: unknown) => {
                    logger.error({ err }, 'WS admin access re-check failed')
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
