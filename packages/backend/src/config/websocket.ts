import { env } from 'node:process'

import { parseInteger } from '#vendor/utils/env/read-int.js'

// feat-062, feat-240 (Р8): how often a server instance re-reads, from the database, the role of
// every open WebSocket connection it holds. A role change is applied at once through the server
// event user_role_changed of the user event bus; this pass is what applies it when that signal
// was lost (Redis down, an instance not yet subscribed): the expected delay while the database
// answers.
const ROLE_RECHECK_DEFAULT_MS = 30_000
const ROLE_RECHECK_MIN_MS = 100
const ROLE_RECHECK_MAX_MS = 3_600_000

export const readWsRoleRecheckIntervalMs = (source: NodeJS.ProcessEnv = env): number => {
    const { value, error } = parseInteger(
        'WS_ROLE_RECHECK_INTERVAL_MS',
        source['WS_ROLE_RECHECK_INTERVAL_MS'],
        ROLE_RECHECK_DEFAULT_MS,
        { min: ROLE_RECHECK_MIN_MS, max: ROLE_RECHECK_MAX_MS },
    )
    if (error !== null) throw new Error(error)
    return value
}

// feat-195: how often a server instance compares the users.session_token every WebSocket
// connection was opened with against the current one, and closes those that differ. The flow
// that revokes a session closes the connections of its own instance at once; this re-check is
// what closes the ones held by another instance, and it bounds how long a revoked session
// keeps receiving broadcasts.
const SESSION_RECHECK_DEFAULT_MS = 30_000

export const readWsSessionRecheckIntervalMs = (source: NodeJS.ProcessEnv = env): number => {
    const { value, error } = parseInteger(
        'WS_SESSION_RECHECK_INTERVAL_MS',
        source['WS_SESSION_RECHECK_INTERVAL_MS'],
        SESSION_RECHECK_DEFAULT_MS,
        { min: ROLE_RECHECK_MIN_MS, max: ROLE_RECHECK_MAX_MS },
    )
    if (error !== null) throw new Error(error)
    return value
}

// feat-149: the budget of one connection, checked before a message costs a Redis command or a
// PostgreSQL query (vendor/utils/rate-limit/ws-message-budget.ts). The defaults leave room for
// the support chat and the admin channel; a heartbeat is counted apart.
const MESSAGES_PER_MINUTE_DEFAULT = 120
const MAX_CONCURRENT_HANDLERS_DEFAULT = 8

export const readWsMessagesPerMinute = (source: NodeJS.ProcessEnv = env): number => {
    const { value, error } = parseInteger(
        'WS_MESSAGES_PER_MINUTE',
        source['WS_MESSAGES_PER_MINUTE'],
        MESSAGES_PER_MINUTE_DEFAULT,
        { min: 1, max: 100_000 },
    )
    if (error !== null) throw new Error(error)
    return value
}

export const readWsMaxConcurrentHandlers = (source: NodeJS.ProcessEnv = env): number => {
    const { value, error } = parseInteger(
        'WS_MAX_CONCURRENT_HANDLERS',
        source['WS_MAX_CONCURRENT_HANDLERS'],
        MAX_CONCURRENT_HANDLERS_DEFAULT,
        { min: 1, max: 1000 },
    )
    if (error !== null) throw new Error(error)
    return value
}

// feat-197: how many connections one user and one IP address may hold on an instance at the
// same time. 0 switches a limit off. The address limit counts everyone behind one NAT: raise
// it for an office or a campus.
const MAX_CONNECTIONS_PER_USER_DEFAULT = 10
const MAX_CONNECTIONS_PER_IP_DEFAULT = 50

export const readWsMaxConnectionsPerUser = (source: NodeJS.ProcessEnv = env): number => {
    const { value, error } = parseInteger(
        'WS_MAX_CONNECTIONS_PER_USER',
        source['WS_MAX_CONNECTIONS_PER_USER'],
        MAX_CONNECTIONS_PER_USER_DEFAULT,
        { min: 0, max: 100_000 },
    )
    if (error !== null) throw new Error(error)
    return value
}

export const readWsMaxConnectionsPerIp = (source: NodeJS.ProcessEnv = env): number => {
    const { value, error } = parseInteger(
        'WS_MAX_CONNECTIONS_PER_IP',
        source['WS_MAX_CONNECTIONS_PER_IP'],
        MAX_CONNECTIONS_PER_IP_DEFAULT,
        { min: 0, max: 1_000_000 },
    )
    if (error !== null) throw new Error(error)
    return value
}

export default Object.freeze({
    /** Re-check period of the role of every WebSocket connection, in ms (WS_ROLE_RECHECK_INTERVAL_MS, default 30000). */
    roleRecheckIntervalMs: readWsRoleRecheckIntervalMs(),
    /** Re-check period of the session of every WebSocket connection, in ms (WS_SESSION_RECHECK_INTERVAL_MS, default 30000). */
    sessionRecheckIntervalMs: readWsSessionRecheckIntervalMs(),
    /** Messages one connection may send in a minute, heartbeats apart (WS_MESSAGES_PER_MINUTE, default 120). */
    messagesPerMinute: readWsMessagesPerMinute(),
    /** Handlers of one connection that may run at once (WS_MAX_CONCURRENT_HANDLERS, default 8). */
    maxConcurrentHandlers: readWsMaxConcurrentHandlers(),
    /** Open connections one user may hold on an instance, 0 = no limit (WS_MAX_CONNECTIONS_PER_USER, default 10). */
    maxConnectionsPerUser: readWsMaxConnectionsPerUser(),
    /** Open connections one IP address may hold on an instance, 0 = no limit (WS_MAX_CONNECTIONS_PER_IP, default 50). */
    maxConnectionsPerIp: readWsMaxConnectionsPerIp(),
})
