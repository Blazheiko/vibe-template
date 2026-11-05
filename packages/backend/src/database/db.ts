import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { connectionOptions } from './pool-options.js'
import appConfig from '#config/app.js'
import databasePoolConfig, {
    POOL_CONNECTION_TIMEOUT_MS,
    QUERY_TIMEOUT_GRACE_MS,
} from '#config/database-pool.js'
import { relations } from './relations.js'
import logger from '#logger'
import { sqlLoggingEnabled } from './sql-logging.js'

export { QUERY_TIMEOUT_GRACE_MS }

// feat-113 (R10): every statement is bounded. The server cancels it (statement_timeout,
// SQLSTATE 57014) and the connection stays usable; for a server that does not answer at all the
// driver's query_timeout fires a little later and pg-pool drops the connection.
const pool = new pg.Pool({
    ...connectionOptions,
    max: 10,
    connectionTimeoutMillis: POOL_CONNECTION_TIMEOUT_MS,
    statement_timeout: databasePoolConfig.queryTimeoutMs,
    query_timeout: databasePoolConfig.queryTimeoutMs + QUERY_TIMEOUT_GRACE_MS,
})

// PostgreSQL dropping an idle connection (restart, failover) emits 'error' on the
// pool; unhandled, Node turns it into an uncaughtException and the server stops.
// The pool replaces the client on its own; requests meanwhile get errors and
// /ready answers 503.
pool.on('error', (err) => {
    logger.error({ err }, 'PostgreSQL pool: idle client error')
})

const db = drizzle({
    client: pool,
    relations,
    logger: sqlLoggingEnabled(appConfig),
})

export { db, pool }
