import { diffMs, nowUnixMs, type UnixMs } from 'shared/brand'
import { Result } from 'better-result'
import type { SessionAuthState } from 'shared/mfa'
import { MFA_REASONS } from 'shared/mfa'
import { roleHasPermission } from 'shared/access'
import type { MyWebSocket, UserConnection } from '#vendor/types/types.js'
import { forbidden, type AppResult } from '#app/services/shared/errors.js'
import { NO_STAFF_DEADLINE, staffSessionDeadline } from '#app/services/auth/mfa/staff-policy.js'
import { broadcastService } from '#app/services/communication/broadcast-service.js'
import logger from '#vendor/utils/logger.js'
import { isClosedSocketError } from '#vendor/utils/network/ws-session-expired.js'
import { ADMIN_CHANNEL, adminChannelSubscribers } from './admin-channel-subscribers.js'

// feat-247 (docs/plan/passkeys-mfa-plan.md, Р11): a staff connection joins the admin channel
// only while its session meets the staff MFA rule, and only until `staffAccessDeadline`. The
// subscribers are kept ordered by it (admin-channel-subscribers.ts), so the publish drops the
// expired ones first; a timer per subscriber tells the client in time. While the rule is off the
// deadline is Infinity: no timer, nothing expires, the channel works as in feat-240.

/** setTimeout keeps a delay in 32 bits; a later deadline is reached in steps. */
const MAX_TIMER_DELAY_MS = 2_147_483_647

const timers = new Map<MyWebSocket, NodeJS.Timeout>()

function getUserData(ws: MyWebSocket): UserConnection {
    return ws.getUserData()
}

const clearTimer = (ws: MyWebSocket): void => {
    const timer = timers.get(ws)
    if (timer === undefined) return
    clearTimeout(timer)
    timers.delete(ws)
}

const scheduleTimer = (ws: MyWebSocket, deadline: UnixMs, nowMs: UnixMs): void => {
    clearTimer(ws)
    if (deadline === NO_STAFF_DEADLINE) return
    const delay = Math.min(Math.max(0, diffMs(deadline, nowMs)), MAX_TIMER_DELAY_MS)
    const timer = setTimeout(() => {
        timers.delete(ws)
        onDeadline(ws, deadline)
    }, delay)
    timer.unref()
    timers.set(ws, timer)
}

/** Leaves the topic now, when the socket is still in it. */
const leave = (ws: MyWebSocket, userData: UserConnection): void => {
    adminChannelSubscribers.remove(ws)
    if (userData.isAdminChannelSubscribed === true) {
        ws.unsubscribe(ADMIN_CHANNEL)
        userData.isAdminChannelSubscribed = false
    }
}

/**
 * The staff MFA proof of this connection went stale: it leaves the channel (when the publish has
 * not dropped it yet), is marked and told. `access_changed` keeps the role, which did not change.
 */
const expire = (ws: MyWebSocket, userData: UserConnection): void => {
    clearTimer(ws)
    leave(ws, userData)
    delete userData.staffAccessDeadline
    userData.mfaStale = true
    const { userId, uuid, role } = userData
    if (userId === undefined || role === undefined) return
    broadcastService.broadcastMessageToUserConnection(userId, uuid, 'access_changed', {
        role,
        reason: MFA_REASONS.mfaSessionRequired,
    })
}

function onDeadline(ws: MyWebSocket, deadline: UnixMs): void {
    try {
        const userData = getUserData(ws)
        if (userData.closed === true) return
        const now = nowUnixMs()
        // A delay longer than a timer holds, or a clock that ran slow: not yet.
        if (now < deadline) {
            scheduleTimer(ws, deadline, now)
            return
        }
        expire(ws, userData)
    } catch (err) {
        if (isClosedSocketError(err)) return
        logger.error({ err }, 'Admin channel: the staff deadline could not be applied')
    }
}

export const adminWsChannelService = {
    subscribeCurrentAdminConnection(ws: MyWebSocket, now = nowUnixMs()): AppResult<void> {
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

        const deadline = staffSessionDeadline(userData.auth, now)
        if (deadline === null) {
            userData.mfaStale = true
            return Result.err(forbidden('Access denied', MFA_REASONS.mfaSessionRequired))
        }

        ws.subscribe(ADMIN_CHANNEL)
        userData.isAdminChannelSubscribed = true
        userData.staffAccessDeadline = deadline
        userData.mfaStale = false
        adminChannelSubscribers.set(ws, deadline)
        scheduleTimer(ws, deadline, now)
        return Result.ok(undefined)
    },

    unsubscribeCurrentAdminConnection(ws: MyWebSocket): { ok: true } {
        const userData = getUserData(ws)
        clearTimer(ws)
        leave(ws, userData)
        delete userData.staffAccessDeadline
        return { ok: true }
    },

    handleConnectionClosed(ws: MyWebSocket): void {
        clearTimer(ws)
        adminChannelSubscribers.remove(ws)
        const userData = getUserData(ws)
        if (userData.isAdminChannelSubscribed === true) {
            userData.isAdminChannelSubscribed = false
        }
    },

    /**
     * feat-247 (Р11): the session of this connection has a new auth state (a step-up). A
     * subscribed connection gets its new deadline (or leaves, when the session does not meet the
     * rule); true when a connection the deadline had taken out may join again, so the caller
     * sends it `admin_channel_ready` (the client decides whether to subscribe).
     */
    refreshConnectionAuth(
        ws: MyWebSocket,
        auth: SessionAuthState | undefined,
        now = nowUnixMs(),
    ): boolean {
        const userData = getUserData(ws)
        if (userData.closed === true) return false
        if (auth === undefined) delete userData.auth
        else userData.auth = auth
        const deadline = staffSessionDeadline(auth, now)
        if (adminChannelSubscribers.has(ws)) {
            if (deadline === null) {
                expire(ws, userData)
                return false
            }
            userData.staffAccessDeadline = deadline
            adminChannelSubscribers.set(ws, deadline)
            scheduleTimer(ws, deadline, now)
            return false
        }
        const wasStale = userData.mfaStale === true
        if (deadline === null) return false
        userData.mfaStale = false
        return (
            wasStale &&
            userData.isAdminChannelSubscribed !== true &&
            userData.adminChannelPaused !== true &&
            roleHasPermission(userData.role, 'users.read')
        )
    },

    /**
     * feat-247 (Р11): the periodic role pass found a connection that may read users but whose
     * session no longer meets the staff rule: it leaves the channel and is told once.
     */
    expireStaffAccess(ws: MyWebSocket): void {
        const userData = getUserData(ws)
        if (userData.mfaStale === true && !adminChannelSubscribers.has(ws)) {
            leave(ws, userData)
            return
        }
        expire(ws, userData)
    },

    hasSubscribers(): boolean {
        return adminChannelSubscribers.size() > 0
    },
}
