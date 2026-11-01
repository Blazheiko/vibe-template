import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import sessionConfig from '#config/session.js'
import logger from '#logger'
import { connectionOptions } from './pool-options.js'

// ADR 0002: the users.session_token read made for every authenticated request has
// its own small pool, for two reasons.
//
// 1. Cancelling. A deadline in application code only stops waiting: the query keeps
//    running on the server and keeps its pooled connection. Here the server cancels
//    it (statement_timeout, SQLSTATE 57014) and the connection stays usable. For a
//    server that does not answer at all (network partition) the driver's
//    query_timeout fires a little later; pg-pool drops a connection that returned
//    an error, so the slot is freed instead of staying occupied. statement_timeout
//    is a property of the connection, so it cannot live on the main pool: it would
//    cap every query of the app.
// 2. Isolation. Authentication cannot be starved by long business queries holding
//    the main pool, and a stuck lookup cannot starve them either.
//
// Waiting for a free connection is bounded by the same deadline.

/** The driver's client-side timeout fires after the server-side cancel has had its chance. */
const QUERY_TIMEOUT_GRACE_MS = 500

/** One PK read per authenticated request takes ~0.1 ms: a handful of connections is plenty. */
export const SESSION_CHECK_POOL_MAX = 5

export interface SessionCheckPoolOptions {
    connection: Pick<
        pg.PoolConfig,
        'host' | 'port' | 'user' | 'password' | 'database' | 'ssl' | 'idleTimeoutMillis'
    >
    timeoutMs: number
    max: number
}

export const createSessionCheckPool = ({
    connection,
    timeoutMs,
    max,
}: SessionCheckPoolOptions): pg.Pool => {
    const pool = new pg.Pool({
        ...connection,
        max,
        connectionTimeoutMillis: timeoutMs,
        statement_timeout: timeoutMs,
        query_timeout: timeoutMs + QUERY_TIMEOUT_GRACE_MS,
    })
    // An idle connection dropped by the server emits 'error'; unhandled it would stop
    // the process (same reason as on the main pool).
    pool.on('error', (err) => {
        logger.error({ err }, 'PostgreSQL session-check pool: idle client error')
    })
    return pool
}

const sessionCheckPool = createSessionCheckPool({
    connection: connectionOptions,
    timeoutMs: sessionConfig.tokenCheckTimeoutMs,
    max: SESSION_CHECK_POOL_MAX,
})

// No query logging: this runs once per authenticated request.
const sessionCheckDb = drizzle({ client: sessionCheckPool })

export { sessionCheckDb, sessionCheckPool }
