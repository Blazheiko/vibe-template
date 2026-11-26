import { nowUnixMs } from 'shared/brand'
import { roleHasPermission, type Role } from 'shared/access'
import { asUserId } from '#app/domain/ids.js'

import { userRoleService } from '#app/services/user/user-role-service.js'
import { adminWsChannelService } from '#app/services/admin/admin-ws-channel-service.js'
import { staffSessionMeets } from '#app/services/auth/mfa/staff-policy.js'
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
// - Every read gets a number when it starts; per user the number of the last settled read (applied
//   or failed) is kept, and the outcome of an older read that settled later is dropped: an old
//   result neither overwrites a newer one nor lifts the pause of a newer failure (review
//   2026-11-21).
// - A read applies only to the connections that were registered when it started. A connection
//   registered meanwhile read its role at connect, possibly after this read did: the older
//   result must not overwrite it (review 2026-11-21).
// - A changed role is applied to the connection first, then the connection is told
//   (`access_changed`), so a request the client sends after it is checked against the new role.
// - A failed read pauses the admin channel of the connections of those users that may use it:
//   they leave it and `ws_can:` refuses them until a read succeeds. The server never joins the
//   channel again itself: it sends `admin_channel_ready` and the client, which knows whether the
//   admin area is still open, subscribes.
// - feat-247 (docs/plan/passkeys-mfa-plan.md, Р11): the channel also needs a session that meets
//   the staff MFA rule now. A connection whose proof went stale leaves it and is told
//   (`access_changed` with `reason`); its deadline timer normally does that first, this pass is
//   the safety net.

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
const lastSettled = new Map<string, number>()

/** The connections of these users registered here now, by user: what a read starting now covers. */
const snapshotOf = (userIds: readonly string[]): Map<string, ReadonlySet<string>> =>
    new Map(
        userIds.map((userId) => [
            userId,
            new Set(wsConnectionRegistry.listUserConnections(userId).map(({ uuid }) => uuid)),
        ]),
    )

/** The connections of `userId` still registered that were in the snapshot of the read. */
const coveredConnections = (
    userId: string,
    covered: ReadonlySet<string> | undefined,
): ReturnType<typeof wsConnectionRegistry.listUserConnections> =>
    covered === undefined || covered.size === 0
        ? []
        : wsConnectionRegistry.listUserConnections(userId).filter(({ uuid }) => covered.has(uuid))

/**
 * Whether the outcome of read `read` for `userId` is the newest settled one; if so it is recorded.
 * A success and a failure take part alike.
 */
const settle = (userId: string, read: number): boolean => {
    if ((lastSettled.get(userId) ?? 0) > read) return false
    lastSettled.set(userId, read)
    return true
}

const userDataOf = (ws: MyWebSocket): UserConnection | null => {
    try {
        return ws.getUserData()
    } catch (err) {
        if (isClosedSocketError(err)) return null
        throw err
    }
}

/** Applies the role read for `userId` to each of its connections here; returns how many changed. */
const apply = (userId: string, role: Role, covered: ReadonlySet<string> | undefined): number => {
    let changed = 0
    for (const { uuid, ws } of coveredConnections(userId, covered)) {
        try {
            const userData = userDataOf(ws)
            if (userData === null) continue
            const previous = userData.role
            const wasPaused = userData.adminChannelPaused === true
            const mayReadUsers = roleHasPermission(role, 'users.read')
            const sessionMeets = staffSessionMeets(userData.auth, nowUnixMs())
            const mayUseChannel = mayReadUsers && sessionMeets
            userData.role = role
            userData.adminChannelPaused = false
            if (!mayReadUsers) adminWsChannelService.unsubscribeCurrentAdminConnection(ws)
            else if (!sessionMeets) adminWsChannelService.expireStaffAccess(ws)
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
const pause = (userId: string, covered: ReadonlySet<string> | undefined): number => {
    let paused = 0
    for (const { uuid, ws } of coveredConnections(userId, covered)) {
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
     * The server bus event user_role_changed: the connections of the user being opened read their
     * role again before registering (feat-243), the registered ones are refreshed here.
     */
    onRoleChanged(userId: string): Promise<RoleSyncReport> {
        wsConnectionRegistry.markConnectingRoleStale(userId)
        return wsRoleSync.refreshUsers([userId])
    },

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
        const snapshot = snapshotOf(ids)

        let roles: Map<string, Role>
        try {
            roles = await userRoleService.findRoles(ids.map((id) => asUserId(id)))
        } catch (err) {
            logger.error({ err, users: ids.length }, 'WS role read failed: admin channel paused')
            for (const userId of ids) {
                // A newer read settled meanwhile: its outcome stands.
                if (!settle(userId, read)) continue
                report.paused += pause(userId, snapshot.get(userId))
            }
            report.failed = ids.length
            return report
        }

        for (const userId of ids) {
            // A newer read settled meanwhile: this one is older news.
            if (!settle(userId, read)) continue
            report.changed += apply(userId, roles.get(userId) ?? 'user', snapshot.get(userId))
        }
        return report
    },

    /** One pass over every user with an open connection here, in batches. */
    async refreshAll(): Promise<RoleSyncReport> {
        const userIds = [...new Set(wsConnectionRegistry.listConnections().map((c) => c.userId))]
        // Forget the users that have no connection here any more.
        const present = new Set(userIds)
        for (const userId of lastSettled.keys()) {
            if (!present.has(userId)) lastSettled.delete(userId)
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
        lastSettled.clear()
    },
}
