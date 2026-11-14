// feat-197 (security review 2026-11-12, M-4): how many WebSocket connections one user and one
// IP address hold on this instance at the same time. The message budget (feat-149) is per
// connection, so without a limit on connections one account multiplied it by opening hundreds
// of sockets, each of which also costs a registry entry and a user_online row.
//
// In memory, per process: a connection is held by the instance that accepted it. With several
// instances the limit applies to each one.

export interface WsConnectionLimits {
    /** 0 switches the limit off. */
    maxConnectionsPerUser: number
    /** 0 switches the limit off. */
    maxConnectionsPerIp: number
}

/** What the upgrade keeps to give the place back when the connection closes. */
export interface WsConnectionSlot {
    userId: string
    ipKey: string
}

export type WsConnectionAdmission =
    { kind: 'ok'; slot: WsConnectionSlot } | { kind: 'limited'; by: 'user' | 'ip' }

const byUser = new Map<string, number>()
const byIp = new Map<string, number>()

const add = (counts: Map<string, number>, key: string): void => {
    counts.set(key, (counts.get(key) ?? 0) + 1)
}

const remove = (counts: Map<string, number>, key: string): void => {
    const next = (counts.get(key) ?? 0) - 1
    if (next > 0) counts.set(key, next)
    else counts.delete(key)
}

/**
 * Takes a place for a new connection, or refuses. Synchronous: the check and the count are one
 * step, so upgrades racing for the last place cannot all get it.
 */
export const acquireWsConnection = (
    userId: string,
    ipKey: string,
    limits: WsConnectionLimits,
): WsConnectionAdmission => {
    const { maxConnectionsPerUser, maxConnectionsPerIp } = limits
    if (maxConnectionsPerUser > 0 && (byUser.get(userId) ?? 0) >= maxConnectionsPerUser) {
        return { kind: 'limited', by: 'user' }
    }
    if (maxConnectionsPerIp > 0 && (byIp.get(ipKey) ?? 0) >= maxConnectionsPerIp) {
        return { kind: 'limited', by: 'ip' }
    }
    add(byUser, userId)
    add(byIp, ipKey)
    return { kind: 'ok', slot: { userId, ipKey } }
}

export const releaseWsConnection = (slot: WsConnectionSlot): void => {
    remove(byUser, slot.userId)
    remove(byIp, slot.ipKey)
}

export const wsConnectionCounts = (
    userId: string,
    ipKey: string,
): { user: number; ip: number } => ({
    user: byUser.get(userId) ?? 0,
    ip: byIp.get(ipKey) ?? 0,
})

/** Test hook: the counters are module state. */
export const __resetWsConnectionLimitForTests = (): void => {
    byUser.clear()
    byIp.clear()
}
