import { Result } from 'better-result'
import type { MyWebSocket, UserConnection } from '#vendor/types/types.js'
import { forbidden, type AppResult } from '#app/services/shared/errors.js'
import type { WsChannel } from 'shared/guards'
import { roleHasPermission } from 'shared/access'

const ADMIN_CHANNEL: WsChannel = 'admin'
let adminSubscriberCount = 0

function getUserData(ws: MyWebSocket): UserConnection {
    return ws.getUserData()
}

export const adminWsChannelService = {
    subscribeCurrentAdminConnection(ws: MyWebSocket): AppResult<void> {
        const userData = getUserData(ws)
        if (
            userData.adminChannelPaused === true ||
            !roleHasPermission(userData.role, 'users.read')
        ) {
            return Result.err(forbidden('Access denied'))
        }

        if (userData.isAdminChannelSubscribed === true) {
            return Result.ok(undefined)
        }

        ws.subscribe(ADMIN_CHANNEL)
        userData.isAdminChannelSubscribed = true
        adminSubscriberCount += 1
        return Result.ok(undefined)
    },

    unsubscribeCurrentAdminConnection(ws: MyWebSocket): { ok: true } {
        const userData = getUserData(ws)
        if (userData.isAdminChannelSubscribed === true) {
            ws.unsubscribe(ADMIN_CHANNEL)
            userData.isAdminChannelSubscribed = false
            adminSubscriberCount = Math.max(0, adminSubscriberCount - 1)
        }
        return { ok: true }
    },

    handleConnectionClosed(ws: MyWebSocket): void {
        const userData = getUserData(ws)
        if (userData.isAdminChannelSubscribed === true) {
            userData.isAdminChannelSubscribed = false
            adminSubscriberCount = Math.max(0, adminSubscriberCount - 1)
        }
    },

    hasSubscribers(): boolean {
        return adminSubscriberCount > 0
    },
}
