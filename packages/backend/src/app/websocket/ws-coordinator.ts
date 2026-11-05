import type { MyWebSocket, UserConnection } from '#vendor/types/types.js'
import { wsConnectionRegistry } from '#app/websocket/ws-connection-registry.js'
import { adminWsChannelService } from '#app/services/admin/admin-ws-channel-service.js'
import { userOnlineService } from '#app/services/communication/user-online-service.js'
import { wsPresenceService } from '#app/services/communication/ws-presence-service.js'
import { userRoleService } from '#app/services/user/user-role-service.js'
import logger from '#vendor/utils/logger.js'

// feat-124: the connect INSERT of each open connection's user_online row, by socket uuid. It is
// not awaited; a disconnect that came first would UPDATE nothing and leave the row open for ever,
// so the disconnect waits for it to settle. feat-128: a failed INSERT may still have committed
// (a timeout or a reset connection after the COMMIT reached the server), so the disconnect UPDATE
// runs whatever the INSERT answered; when there really is no row it finds none and only warns.
const onlineRows = new Map<string, Promise<void>>()

// feat-138 (sixth review L12): the disconnect UPDATEs still running. The shutdown closes every
// socket (closeAllWs) and then ends the pool; it drains these first, or pool.end() cuts them and
// the rows stay open.
const pendingDisconnects = new Set<Promise<void>>()

/**
 * Waits for the user_online disconnects still running, at most `timeoutMs`. True when all of
 * them settled, false at the deadline (the shutdown goes on; those rows stay open).
 */
const drainDisconnects = async (timeoutMs: number): Promise<boolean> => {
    if (pendingDisconnects.size === 0) return true
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<false>((resolve) => {
        timer = setTimeout(() => {
            resolve(false)
        }, timeoutMs)
    })
    try {
        return await Promise.race([
            Promise.allSettled([...pendingDisconnects]).then(() => true as const),
            deadline,
        ])
    } finally {
        clearTimeout(timer)
    }
}

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
    const connectSettled = userOnlineService
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
    onlineRows.set(userData.uuid, connectSettled)

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

    const connectSettled = onlineRows.get(userData.uuid)
    onlineRows.delete(userData.uuid)
    const connectionDurationMs = Math.max(0, Date.now() - userData.timeStart)
    // A connection that closed before its row was tracked (while its role was read) has none.
    if (connectSettled !== undefined) {
        const disconnect: Promise<void> = connectSettled
            .then(async () => {
                await userOnlineService.trackDisconnected({
                    socketUuid: userData.uuid,
                    disconnectedAt,
                    closeCode: code,
                    connectionDurationMs,
                    isLastConnection,
                })
            })
            .catch((error: unknown) => {
                logger.error(
                    { err: error, userId, socketUuid: userData.uuid },
                    'user_online: failed to track disconnect',
                )
            })
        pendingDisconnects.add(disconnect)
        void disconnect.finally(() => {
            pendingDisconnects.delete(disconnect)
        })
    }

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
    drainDisconnects,
}

/** For tests: the user_online rows still tracked. */
export const __onlineRowsForTests = onlineRows
