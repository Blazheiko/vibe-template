import { env } from 'node:process'

import { parseInteger } from '#vendor/utils/env/read-int.js'

// feat-062: how often a server instance re-reads the role of the WebSocket
// connections that hold the admin role. Nothing in the application changes
// users.role (it is edited in the database), so this re-check is the only way a
// demoted admin loses the admin channel and the admin WS routes on a connection
// that stays open; it runs on every instance, from the database, with no Redis.
const ADMIN_RECHECK_DEFAULT_MS = 30_000
const ADMIN_RECHECK_MIN_MS = 100
const ADMIN_RECHECK_MAX_MS = 3_600_000

export const readWsAdminRecheckIntervalMs = (source: NodeJS.ProcessEnv = env): number => {
    const { value, error } = parseInteger(
        'WS_ADMIN_RECHECK_INTERVAL_MS',
        source['WS_ADMIN_RECHECK_INTERVAL_MS'],
        ADMIN_RECHECK_DEFAULT_MS,
        { min: ADMIN_RECHECK_MIN_MS, max: ADMIN_RECHECK_MAX_MS },
    )
    if (error !== null) throw new Error(error)
    return value
}

export default Object.freeze({
    /** Re-check period of admin WebSocket connections, in ms (WS_ADMIN_RECHECK_INTERVAL_MS, default 30000). */
    adminRecheckIntervalMs: readWsAdminRecheckIntervalMs(),
})
