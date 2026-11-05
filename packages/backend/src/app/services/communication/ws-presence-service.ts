import { adminOnlineUsersService } from '#app/services/admin/admin-online-users-service.js'
import { adminWsChannelService } from '#app/services/admin/admin-ws-channel-service.js'
import { broadcastService } from '#app/services/communication/broadcast-service.js'
import logger from '#logger'
import { wsConnectionRegistry } from '#app/websocket/ws-connection-registry.js'
import type { WebSocketConnectionEvent, WebSocketDisconnectionEvent } from '#vendor/types/types.js'

export const wsPresenceService = {
    async onUserConnected(event: WebSocketConnectionEvent): Promise<void> {
        await broadcastOnlineToAdminsOnConnect(event.userId)
    },

    async onUserDisconnected(event: WebSocketDisconnectionEvent): Promise<void> {
        await broadcastOnlineToAdminsOnDisconnect(event.userId)
    },
}

async function broadcastOnlineToAdminsOnConnect(userId: string): Promise<void> {
    if (!adminWsChannelService.hasSubscribers()) return

    try {
        const user = await adminOnlineUsersService.getOnlineUserSnapshot(userId)
        if (user === null) return
        // feat-124: the snapshot reads the database. A user who went offline meanwhile has had
        // the remove sent already; an upsert after it would leave a ghost in the admin list.
        if (!wsConnectionRegistry.isUserOnline(userId)) return
        broadcastService.broadcastMessageToChannel('admin', 'admin_user_online_upsert', {
            id: user.id,
            name: user.name,
            email: user.email,
            appType: user.appType,
            userAgent: user.userAgent,
            connectionsCount: user.connectionsCount,
        })
    } catch (error) {
        logger.error(
            { err: error },
            `Failed to broadcast admin online connect event for user ${userId}`,
        )
    }
}

async function broadcastOnlineToAdminsOnDisconnect(userId: string): Promise<void> {
    if (!adminWsChannelService.hasSubscribers()) return

    try {
        broadcastService.broadcastMessageToChannel('admin', 'admin_user_online_remove', {
            id: userId,
        })
    } catch (error) {
        logger.error(
            { err: error },
            `Failed to broadcast admin online disconnect event for user ${userId}`,
        )
    }
    return Promise.resolve()
}
