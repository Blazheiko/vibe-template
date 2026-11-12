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
    unregisterConnection,
    isUserOnline,
    findOnlineUsers,
    forEachConnection,
    listConnections,
    listUserConnections,
    getConnection,
    getOnlineUsers,
    getOnlineUserMeta,
}
