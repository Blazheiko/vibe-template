import { createEnvReader } from '#vendor/utils/env/env-reader.js'

// feat-113 (R10): settings of the main pg pool that are not connection settings. They live apart
// from config/database.ts, which drizzle-kit loads without path aliases and which throws instead of
// reporting a config error.

export interface DatabasePoolConfig {
    /**
     * Upper bound of one statement on the main pool (statement_timeout; the driver's
     * query_timeout fires a little later). A hung query is cancelled instead of holding its
     * connection forever.
     */
    queryTimeoutMs: number
    configError: string | null
}

/** The driver's client-side timeout fires after the server-side cancel has had its chance. */
export const QUERY_TIMEOUT_GRACE_MS = 500
/** How long a query waits for a connection of the main pool. */
export const POOL_CONNECTION_TIMEOUT_MS = 2000

/**
 * feat-135: the longest one statement on the main pool can take before the client gives up: the
 * wait for a connection, then the query up to its client-side timeout.
 */
export const statementBoundMs = (config: Pick<DatabasePoolConfig, 'queryTimeoutMs'>): number =>
    POOL_CONNECTION_TIMEOUT_MS + config.queryTimeoutMs + QUERY_TIMEOUT_GRACE_MS

export const readDatabasePoolConfig = (
    env: NodeJS.ProcessEnv = process.env,
): DatabasePoolConfig => {
    const reader = createEnvReader(env)
    const queryTimeoutMs = reader.int('DB_QUERY_TIMEOUT_MS', 10_000, { min: 100, max: 600_000 })
    return { queryTimeoutMs, configError: reader.error }
}

export default Object.freeze(readDatabasePoolConfig())
