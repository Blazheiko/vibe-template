import { roleHasPermission, type Role } from 'shared/access'

import { userRoleService } from '#app/services/user/user-role-service.js'
import { adminWsChannelService } from '#app/services/admin/admin-ws-channel-service.js'
import { broadcastService } from '#app/services/communication/broadcast-service.js'
import { wsConnectionRegistry } from '#app/websocket/ws-connection-registry.js'
import websocketConfig from '#config/websocket.js'
import logger from '#vendor/utils/logger.js'
import { isClosedSocketError } from '#vendor/utils/network/ws-session-expired.js'
import type { MyWebSocket, UserConnection } from '#vendor/types/types.js'

// feat-240 (docs/plan/roles-permissions-plan.md Р8): the role of an open WebSocket connection is
// read when it is opened; afterwards this module keeps it in step with users.role. One mechanism
// for both paths: the server bus event user_role_changed (a role was changed somewhere) and a
// periodic pass over every connection of this instance (a signal may be lost).
//
// - Every read gets a number when it starts; per user the number of the last applied read is
//   kept, and the result of an older read that finished later is dropped.
// - A changed role is applied to the connection first, then the connection is told
//   (`access_changed`), so a request the client sends after it is checked against the new role.
// - A failed read pauses the admin channel of the connections of those users that may use it:
//   they leave it and `ws_can:` refuses them until a read succeeds. The server never joins the
//   channel again itself: it sends `admin_channel_ready` and the client, which knows whether the
//   admin area is still open, subscribes.

/** Ids per query of the periodic pass. */
export const ROLE_SYNC_BATCH = 1000

export interface RoleSyncReport {
    users: number
    /** Connections whose role changed. */
    changed: number
    /** Connections whose admin channel was paused by a failed read. */
    paused: number
    /** Users whose read failed. */
    failed: number
}

let readCounter = 0
const lastApplied = new Map<string, number>()

const userDataOf = (ws: MyWebSocket): UserConnection | null => {
    try {
        return ws.getUserData()
    } catch (err) {
        if (isClosedSocketError(err)) return null
        throw err
    }
}

/** Applies the role read for `userId` to each of its connections here; returns how many changed. */
const apply = (userId: string, role: Role): number => {
    let changed = 0
    for (const { uuid, ws } of wsConnectionRegistry.listUserConnections(userId)) {
        try {
            const userData = userDataOf(ws)
            if (userData === null) continue
            const previous = userData.role
            const wasPaused = userData.adminChannelPaused === true
            const mayUseChannel = roleHasPermission(role, 'users.read')
            userData.role = role
            userData.adminChannelPaused = false
            if (!mayUseChannel) adminWsChannelService.unsubscribeCurrentAdminConnection(ws)
            if (previous !== role) {
                changed += 1
                broadcastService.broadcastMessageToUserConnection(userId, uuid, 'access_changed', {
                    role,
                })
            }
            if (wasPaused && mayUseChannel) {
                broadcastService.broadcastMessageToUserConnection(
                    userId,
                    uuid,
                    'admin_channel_ready',
                    {},
                )
            }
        } catch (err) {
            if (isClosedSocketError(err)) continue
            logger.error({ err, userId, socketUuid: uuid }, 'WS role could not be applied')
        }
    }
    return changed
}

/** A failed read: the connections that may use the admin channel leave it until a read succeeds. */
const pause = (userId: string): number => {
    let paused = 0
    for (const { uuid, ws } of wsConnectionRegistry.listUserConnections(userId)) {
        try {
            const userData = userDataOf(ws)
            if (userData === null || !roleHasPermission(userData.role, 'users.read')) continue
            adminWsChannelService.unsubscribeCurrentAdminConnection(ws)
            userData.adminChannelPaused = true
            paused += 1
        } catch (err) {
            if (isClosedSocketError(err)) continue
            logger.error({ err, userId, socketUuid: uuid }, 'WS admin channel could not be paused')
        }
    }
    return paused
}

let timer: NodeJS.Timeout | undefined
let running = false

export const wsRoleSync = {
    /**
     * Reads the roles of these users with one query and applies them to their connections on
     * this instance. A user that no longer exists gets the role `user`. Never throws.
     */
    async refreshUsers(userIds: readonly string[]): Promise<RoleSyncReport> {
        const ids = [...new Set(userIds)]
        const report: RoleSyncReport = { users: ids.length, changed: 0, paused: 0, failed: 0 }
        if (ids.length === 0) return report
        readCounter += 1
        const read = readCounter

        let roles: Map<string, Role>
        try {
            roles = await userRoleService.findRoles(ids.map((id) => BigInt(id)))
        } catch (err) {
            logger.error({ err, users: ids.length }, 'WS role read failed: admin channel paused')
            for (const userId of ids) report.paused += pause(userId)
            report.failed = ids.length
            return report
        }

        for (const userId of ids) {
            // A newer read was applied meanwhile: this one is older news.
            if ((lastApplied.get(userId) ?? 0) > read) continue
            lastApplied.set(userId, read)
            report.changed += apply(userId, roles.get(userId) ?? 'user')
        }
        return report
    },

    /** One pass over every user with an open connection here, in batches. */
    async refreshAll(): Promise<RoleSyncReport> {
        const userIds = [...new Set(wsConnectionRegistry.listConnections().map((c) => c.userId))]
        // Forget the users that have no connection here any more.
        const present = new Set(userIds)
        for (const userId of lastApplied.keys()) {
            if (!present.has(userId)) lastApplied.delete(userId)
        }
        const total: RoleSyncReport = { users: 0, changed: 0, paused: 0, failed: 0 }
        for (let start = 0; start < userIds.length; start += ROLE_SYNC_BATCH) {
            const report = await wsRoleSync.refreshUsers(
                userIds.slice(start, start + ROLE_SYNC_BATCH),
            )
            total.users += report.users
            total.changed += report.changed
            total.paused += report.paused
            total.failed += report.failed
        }
        return total
    },

    start(intervalMs: number = websocketConfig.roleRecheckIntervalMs): void {
        if (timer !== undefined) return
        timer = setInterval(() => {
            // A slow database must not stack passes.
            if (running) return
            running = true
            wsRoleSync
                .refreshAll()
                .catch((err: unknown) => {
                    logger.error({ err }, 'WS role pass failed')
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

    /** For tests: forget the read numbers. */
    reset(): void {
        readCounter = 0
        lastApplied.clear()
    },
}
