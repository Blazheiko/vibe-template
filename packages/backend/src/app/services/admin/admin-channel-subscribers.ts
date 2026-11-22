import type { WsChannel } from 'shared/guards'

import type { MyWebSocket, UserConnection } from '#vendor/types/types.js'
import logger from '#vendor/utils/logger.js'
import { isClosedSocketError } from '#vendor/utils/network/ws-session-expired.js'

// feat-247 (docs/plan/passkeys-mfa-plan.md, Р11): the subscribers of the admin channel on this
// instance, ordered by `staffAccessDeadline`. A uWS publish cannot be filtered by recipient and a
// Node.js timer is not run on time, so the one place that publishes to the channel
// (broadcastService.broadcastMessageToChannel) first calls `dropExpired(now)`: every subscriber
// whose deadline has passed leaves the topic synchronously, before the publish. No module here
// sends anything, so the broadcast service can depend on it without a cycle.

export const ADMIN_CHANNEL: WsChannel = 'admin'

interface Entry {
    ws: MyWebSocket
    deadline: number
}

/** Ascending by deadline; Infinity (the rule is off) at the end. */
const ordered: Entry[] = []
const bySocket = new Map<MyWebSocket, Entry>()

const userDataOf = (ws: MyWebSocket): UserConnection | null => {
    try {
        return ws.getUserData()
    } catch (err) {
        if (isClosedSocketError(err)) return null
        throw err
    }
}

/** The index where an entry with `deadline` goes: after every entry with a deadline ≤ it. */
const insertionIndex = (deadline: number): number => {
    let low = 0
    let high = ordered.length
    while (low < high) {
        const middle = (low + high) >>> 1
        const entry = ordered[middle]
        if (entry !== undefined && entry.deadline <= deadline) low = middle + 1
        else high = middle
    }
    return low
}

/** An expired subscriber leaves the uWS topic; a closed one has left already. */
const leaveTopic = (ws: MyWebSocket): void => {
    try {
        const userData = userDataOf(ws)
        if (userData === null) return
        ws.unsubscribe(ADMIN_CHANNEL)
        userData.isAdminChannelSubscribed = false
        userData.mfaStale = true
    } catch (err) {
        if (isClosedSocketError(err)) return
        logger.error({ err }, 'Admin channel: an expired subscriber could not leave')
    }
}

const detach = (entry: Entry): void => {
    const index = ordered.indexOf(entry)
    if (index !== -1) ordered.splice(index, 1)
    bySocket.delete(entry.ws)
}

export const adminChannelSubscribers = {
    /** Adds the socket with its deadline, or moves it when it is there already. */
    set(ws: MyWebSocket, deadline: number): void {
        const existing = bySocket.get(ws)
        if (existing !== undefined) detach(existing)
        const entry: Entry = { ws, deadline }
        ordered.splice(insertionIndex(deadline), 0, entry)
        bySocket.set(ws, entry)
    },

    /** Forgets the socket; true when it was there. */
    remove(ws: MyWebSocket): boolean {
        const entry = bySocket.get(ws)
        if (entry === undefined) return false
        detach(entry)
        return true
    },

    has(ws: MyWebSocket): boolean {
        return bySocket.has(ws)
    },

    deadlineOf(ws: MyWebSocket): number | undefined {
        return bySocket.get(ws)?.deadline
    },

    size(): number {
        return ordered.length
    },

    /**
     * Synchronously takes every subscriber whose deadline is ≤ `now` out of the admin topic and
     * marks it stale; returns how many left. Its timer still tells the client (`access_changed`).
     */
    dropExpired(now: number): number {
        let dropped = 0
        let entry = ordered[0]
        while (entry !== undefined && entry.deadline <= now) {
            ordered.shift()
            bySocket.delete(entry.ws)
            dropped += 1
            leaveTopic(entry.ws)
            entry = ordered[0]
        }
        return dropped
    },

    /** For tests: forget every subscriber. */
    reset(): void {
        ordered.length = 0
        bySocket.clear()
    },
}
