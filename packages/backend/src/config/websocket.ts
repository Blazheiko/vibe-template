import { env } from 'node:process'

// feat-062: how often a server instance re-reads the role of the WebSocket
// connections that hold the admin role. Nothing in the application changes
// users.role (it is edited in the database), so this re-check is the only way a
// demoted admin loses the admin channel and the admin WS routes on a connection
// that stays open; it runs on every instance, from the database, with no Redis.
const ADMIN_RECHECK_DEFAULT_MS = 30_000
const ADMIN_RECHECK_MIN_MS = 100
const ADMIN_RECHECK_MAX_MS = 3_600_000

export const readWsAdminRecheckIntervalMs = (source: NodeJS.ProcessEnv = env): number => {
    const raw = source['WS_ADMIN_RECHECK_INTERVAL_MS']
    if (raw === undefined || raw.trim() === '') return ADMIN_RECHECK_DEFAULT_MS
    // Decimal digits only: Number() would also take "1e3" and "0x10".
    const value = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN
    if (!Number.isInteger(value) || value < ADMIN_RECHECK_MIN_MS || value > ADMIN_RECHECK_MAX_MS) {
        throw new Error(
            `WS_ADMIN_RECHECK_INTERVAL_MS must be an integer from ${String(ADMIN_RECHECK_MIN_MS)} to ${String(ADMIN_RECHECK_MAX_MS)}, got "${raw}"`,
        )
    }
    return value
}

export default Object.freeze({
    /** Re-check period of admin WebSocket connections, in ms (WS_ADMIN_RECHECK_INTERVAL_MS, default 30000). */
    adminRecheckIntervalMs: readWsAdminRecheckIntervalMs(),
})
