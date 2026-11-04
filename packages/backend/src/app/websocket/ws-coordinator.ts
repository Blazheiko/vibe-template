import type { MyWebSocket, UserConnection } from '#vendor/types/types.js'
import { wsConnectionRegistry } from '#app/websocket/ws-connection-registry.js'
import { adminWsChannelService } from '#app/services/admin/admin-ws-channel-service.js'
import { userOnlineService } from '#app/services/communication/user-online-service.js'
import { wsPresenceService } from '#app/services/communication/ws-presence-service.js'
import { userRoleService } from '#app/services/user/user-role-service.js'
import logger from '#vendor/utils/logger.js'

/**
 * Guards below narrow `userId`/`sessionId` from `string | undefined`
 * (as declared in `UserConnection`) to `string`. The transport layer
 * (`onOpen` in ws-handlers.ts) already rejects connections without auth
 * data, so these branches should never fire — they exist solely for
 * TypeScript type narrowing.
 */
const handleConnected = async (ws: MyWebSocket, userData: UserConnection): Promise<void> => {
    const { userId, sessionId } = userData
    if (userId === undefined || sessionId === undefined) return
    const connectedAt = new Date()

    const role = await userRoleService.findRole(BigInt(userId))
    // feat-107: the socket may have closed while the role was read. A closed socket must not
    // enter the registry; its close handler has already run and will not take it out again.
    if (userData.closed === true) return
    if (role !== undefined) {
        userData.role = role
    }

    const isFirstConnection = wsConnectionRegistry.registerConnection(userId, userData.uuid, ws, {
        ip: userData.ip,
        userAgent: userData.userAgent,
        appType: userData.appType,
    })
    userOnlineService
        .trackConnected({
            userId: BigInt(userId),
            sessionId,
            socketUuid: userData.uuid,
            role: userData.role,
            typeApp: userData.appType,
            ipAddress: userData.ip,
            userAgent: userData.userAgent,
            connectedAt,
            isFirstConnection,
        })
        .catch((error: unknown) => {
            logger.error(
                { err: error, userId, socketUuid: userData.uuid },
                'user_online: failed to track connect',
            )
        })

    if (isFirstConnection) {
        await wsPresenceService.onUserConnected({
            userId,
            sessionId,
            uuid: userData.uuid,
            ip: userData.ip,
            userAgent: userData.userAgent,
            timestamp: connectedAt.getTime(),
            ws,
        })
    }
}

const handleDisconnected = async (
    _ws: MyWebSocket,
    userData: UserConnection,
    code: number,
): Promise<void> => {
    const { userId, sessionId } = userData
    if (userId === undefined || sessionId === undefined) return
    const disconnectedAt = new Date()

    // Remove the closed socket from the in-memory registry FIRST, synchronously.
    // uWS already invalidated the socket by the time onClose fires; if we await
    // anything before unregistering, broadcast loops can still pick up the dead
    // socket and crash on `.send()` with "Invalid access of closed uWS.WebSocket".
    const isLastConnection = wsConnectionRegistry.unregisterConnection(userId, userData.uuid)

    adminWsChannelService.handleConnectionClosed(_ws)

    userOnlineService
        .trackDisconnected({
            socketUuid: userData.uuid,
            disconnectedAt,
            closeCode: code,
            connectionDurationMs: Math.max(0, Date.now() - userData.timeStart),
            isLastConnection,
        })
        .catch((error: unknown) => {
            logger.error(
                { err: error, userId, socketUuid: userData.uuid },
                'user_online: failed to track disconnect',
            )
        })

    if (isLastConnection) {
        await wsPresenceService.onUserDisconnected({
            userId,
            sessionId,
            uuid: userData.uuid,
            code,
            timestamp: disconnectedAt.getTime(),
        })
    }
}

export const websocketCoordinator = {
    handleConnected,
    handleDisconnected,
}
