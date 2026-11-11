import pg from 'pg'
import healthConfig from '#config/health.js'
import logger from '#logger'
import { connectionOptions } from './pool-options.js'

// feat-113 (R10): GET /ready pings PostgreSQL over its own single connection, not the main pool
// (a saturated pool would make it wait for a connection) and not the session-check pool (the
// health check must not compete with authentication).
//
// - Every step is bounded by the readiness deadline: getting the connection, the statement on the
//   server (statement_timeout) and the wait for the answer (query_timeout). A connection that
//   timed out is dropped by pg-pool and the next probe opens a new one.
// - One probe at a time: a ping that arrives while one is in flight gets the result of that one
//   instead of starting another, so frequent health checks against a stuck database hold one
//   connection. It used to be refused at once ("not ready"), which also answered 503 from a
//   healthy instance whenever two checkers asked at the same moment (feat-159).

export const READINESS_PROBE_APPLICATION_NAME = 'readiness-probe'

export interface ReadinessProbeOptions {
    connection: Pick<
        pg.PoolConfig,
        'host' | 'port' | 'user' | 'password' | 'database' | 'ssl' | 'idleTimeoutMillis' | 'options'
    >
    timeoutMs: number
    /** What the probe runs; tests make it slow. */
    statement?: () => string
    applicationName?: string
}

export interface ReadinessProbe {
    /**
     * Resolves when PostgreSQL answered; rejects on any failure. Concurrent calls share one
     * query and its outcome.
     */
    ping(): Promise<void>
    end(): Promise<void>
}

/**
 * feat-138 (sixth review L14): the probe's whole budget, split between waiting for the connection
 * and the query, so one probe ends within `timeoutMs`. Each part used to get all of it, and the
 * worst probe took about twice as long, and so did every /ready request that shared it. Each part gets at least 1 ms.
 */
export const probeTimeouts = (timeoutMs: number): { connectMs: number; queryMs: number } => {
    const connectMs = Math.max(1, Math.floor(timeoutMs / 2))
    return { connectMs, queryMs: Math.max(1, timeoutMs - connectMs) }
}

export const createReadinessProbe = ({
    connection,
    timeoutMs,
    statement = (): string => 'SELECT 1',
    applicationName = READINESS_PROBE_APPLICATION_NAME,
}: ReadinessProbeOptions): ReadinessProbe => {
    const { connectMs, queryMs } = probeTimeouts(timeoutMs)
    const pool = new pg.Pool({
        ...connection,
        max: 1,
        application_name: applicationName,
        connectionTimeoutMillis: connectMs,
        statement_timeout: queryMs,
        query_timeout: queryMs,
    })
    // An idle connection dropped by the server emits 'error'; unhandled it would stop the process.
    pool.on('error', (err) => {
        logger.error({ err }, 'PostgreSQL readiness probe: idle client error')
    })

    let inFlight: Promise<void> | null = null

    return {
        ping(): Promise<void> {
            if (inFlight !== null) return inFlight
            const run = pool.query(statement()).then(() => undefined)
            inFlight = run
            const clear = (): void => {
                inFlight = null
            }
            run.then(clear, clear)
            return run
        },
        end: () => pool.end(),
    }
}

const readinessProbe = createReadinessProbe({
    connection: connectionOptions,
    timeoutMs: healthConfig.readinessTimeoutMs,
})

export default readinessProbe
