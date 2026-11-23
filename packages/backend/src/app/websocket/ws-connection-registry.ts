import type { MyWebSocket } from '#vendor/types/types.js'

// feat-107: each connection keeps its own ip, user agent and app type, so summaries never read
// ws.getUserData() from a stored socket (it throws once the socket has closed).
interface StoredConnection {
    ws: MyWebSocket
    ip: string
    userAgent: string
    appType: 'web' | 'pwa'
    sessionId: string
    userToken: string | undefined
}

interface UserConnections {
    ip: string
    userAgent: string
    appType: 'web' | 'pwa'
    connections: Map<string, StoredConnection>
}

type UserStorage = Map<string, UserConnections>

const userStorage: UserStorage = new Map<string, UserConnections>()

export interface ConnectionMeta {
    ip: string
    userAgent: string
    appType: 'web' | 'pwa'
    /** The session the connection was opened from, and the users.session_token it carried. */
    sessionId: string
    userToken: string | undefined
}

export interface ListedConnection {
    userId: string
    uuid: string
    ws: MyWebSocket
    sessionId: string
    userToken: string | undefined
}

function summarizeAppType(connections: Iterable<StoredConnection>): 'web' | 'pwa' {
    for (const connection of connections) {
        if (connection.appType === 'pwa') {
            return 'pwa'
        }
    }

    return 'web'
}

// feat-210: connections whose upgrade was let in and whose handleConnected still awaits its
// reads. They are not in `userStorage` yet, so a revocation that closes the user's connections
// would miss them; it marks them here instead, and handleConnected closes a marked one.
interface ConnectingEntry {
    userId: string
    sessionId: string
    /** The users.session_token the connection's session carries (a recovery's close, Р8). */
    userToken: string | undefined
    revoked: boolean
    // feat-243 (review 2026-11-21): a role change was signalled while the connection was being
    // opened; the role it read may predate it, so it reads the role again before registering.
    roleStale: boolean
}
const connecting = new Map<string, ConnectingEntry>()

/**
 * Notes a connection that is being opened. The returned function ends the wait and answers
 * whether the session was revoked meanwhile; it must be called exactly once.
 */
const beginConnecting = (
    userId: string,
    uuid: string,
    sessionId: string,
    userToken?: string,
): (() => boolean) => {
    const entry: ConnectingEntry = {
        userId,
        sessionId,
        userToken,
        revoked: false,
        roleStale: false,
    }
    connecting.set(uuid, entry)
    return () => {
        connecting.delete(uuid)
        return entry.revoked
    }
}

/**
 * Marks the user's connections that are being opened: all, those of one session, or those whose
 * session carries one users.session_token.
 */
const revokeConnecting = (
    userId: string,
    sessionId?: string,
    // feat-221: a password change spares the session that asked for it.
    exceptSessionId?: string,
    // Р8: a recovery sign-in closes only the sessions of the token it rotated.
    userToken?: string,
): number => {
    let marked = 0
    for (const entry of connecting.values()) {
        if (entry.userId !== userId) continue
        if (sessionId !== undefined && entry.sessionId !== sessionId) continue
        if (exceptSessionId !== undefined && entry.sessionId === exceptSessionId) continue
        if (userToken !== undefined && entry.userToken !== userToken) continue
        entry.revoked = true
        marked += 1
    }
    return marked
}

/** Marks the user's connections being opened: their role must be read again (feat-243). */
const markConnectingRoleStale = (userId: string): number => {
    let marked = 0
    for (const entry of connecting.values()) {
        if (entry.userId !== userId) continue
        entry.roleStale = true
        marked += 1
    }
    return marked
}

/**
 * Answers whether a role change was signalled for this connection being opened since the last
 * call, and clears the mark.
 */
const takeConnectingRoleStale = (uuid: string): boolean => {
    const entry = connecting.get(uuid)
    if (entry?.roleStale !== true) return false
    entry.roleStale = false
    return true
}

/**
 * Registers a new WS connection for a user.
 * Returns true if this is the user's first connection (no prior active connections).
 */
const registerConnection = (
    userId: string,
    uuid: string,
    ws: MyWebSocket,
    meta: ConnectionMeta,
): boolean => {
    const stored: StoredConnection = {
        ws,
        ip: meta.ip,
        userAgent: meta.userAgent,
        appType: meta.appType,
        sessionId: meta.sessionId,
        userToken: meta.userToken,
    }
    const existing = userStorage.get(userId)
    if (existing !== undefined) {
        existing.connections.set(uuid, stored)
        existing.userAgent = meta.userAgent
        existing.ip = meta.ip
        existing.appType = summarizeAppType(existing.connections.values())
        return false
    }
    userStorage.set(userId, {
        ip: meta.ip,
        userAgent: meta.userAgent,
        appType: meta.appType,
        connections: new Map([[uuid, stored]]),
    })
    return true
}

/**
 * Unregisters a WS connection for a user.
 * Returns true if this was the user's last connection (no remaining active connections).
 */
const unregisterConnection = (userId: string, uuid: string): boolean => {
    const existing = userStorage.get(userId)
    if (existing === undefined) return false
    existing.connections.delete(uuid)
    if (existing.connections.size === 0) {
        userStorage.delete(userId)
        return true
    }
    existing.appType = summarizeAppType(existing.connections.values())

    return false
}

const isUserOnline = (userId: string): boolean => userStorage.has(userId)

/** feat-233 (Р12, Р13): whether a connection of this session is open on this instance. */
const hasSessionConnection = (userId: string, sessionId: string): boolean => {
    const user = userStorage.get(userId)
    if (user === undefined) return false
    for (const connection of user.connections.values()) {
        if (connection.sessionId === sessionId) return true
    }
    return false
}

const findOnlineUsers = (userIds: string[]): string[] => {
    const online: string[] = []
    for (const id of userIds) {
        if (userStorage.has(id)) online.push(id)
    }
    return online
}

const forEachConnection = (userId: string, fn: (ws: MyWebSocket, uuid: string) => void): void => {
    const user = userStorage.get(userId)
    if (user === undefined) return
    for (const [uuid, connection] of user.connections) {
        fn(connection.ws, uuid)
    }
}

const getConnection = (userId: string, uuid: string): MyWebSocket | undefined =>
    userStorage.get(userId)?.connections.get(uuid)?.ws

const getOnlineUsers = (): {
    userId: string
    ip: string
    userAgent: string
    appType: 'web' | 'pwa'
    connectionsCount: number
}[] =>
    Array.from(userStorage.entries()).map(([userId, user]) => ({
        userId,
        ip: user.ip,
        userAgent: user.userAgent,
        appType: user.appType,
        connectionsCount: user.connections.size,
    }))

const getOnlineUserMeta = (
    userId: string,
):
    | {
          ip: string
          userAgent: string
          appType: 'web' | 'pwa'
          connectionsCount: number
          connections: {
              uuid: string
              ip: string
              userAgent: string
              appType: 'web' | 'pwa'
          }[]
      }
    | undefined => {
    const user = userStorage.get(userId)
    if (user === undefined) return undefined
    return {
        ip: user.ip,
        userAgent: user.userAgent,
        appType: user.appType,
        connectionsCount: user.connections.size,
        connections: Array.from(user.connections.entries()).map(([uuid, connection]) => ({
            uuid,
            ip: connection.ip,
            userAgent: connection.userAgent,
            appType: connection.appType,
        })),
    }
}

/** Every open connection of this instance, with the user it belongs to. */
const listConnections = (): ListedConnection[] => {
    const all: ListedConnection[] = []
    for (const [userId, user] of userStorage) {
        for (const [uuid, connection] of user.connections) {
            all.push({
                userId,
                uuid,
                ws: connection.ws,
                sessionId: connection.sessionId,
                userToken: connection.userToken,
            })
        }
    }
    return all
}

/** The open connections of one user on this instance. */
const listUserConnections = (userId: string): ListedConnection[] => {
    const user = userStorage.get(userId)
    if (user === undefined) return []
    return Array.from(user.connections, ([uuid, connection]) => ({
        userId,
        uuid,
        ws: connection.ws,
        sessionId: connection.sessionId,
        userToken: connection.userToken,
    }))
}

export const wsConnectionRegistry = {
    registerConnection,
    beginConnecting,
    revokeConnecting,
    markConnectingRoleStale,
    takeConnectingRoleStale,
    unregisterConnection,
    isUserOnline,
    hasSessionConnection,
    findOnlineUsers,
    forEachConnection,
    listConnections,
    listUserConnections,
    getConnection,
    getOnlineUsers,
    getOnlineUserMeta,
}
