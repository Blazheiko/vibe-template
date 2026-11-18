import { env } from 'node:process'

import { parseScheduleDuration } from '#app/scheduler/schedule.js'

// feat-223: the auth-token-cleanup job (app/scheduler/jobs/auth-token-cleanup.ts). Kept out of
// config/auth.ts, which most of the auth code imports, so that only the job and the startup check
// load the duration parser.

const RETENTION_DEFAULT = '7d'

export interface AuthTokenCleanupConfig {
    /** AUTH_TOKEN_RETENTION: how long a token is kept after its expires_at, ms (default 7d). */
    retentionMs: number
    configError: string | null
}

export function readAuthTokenCleanupConfig(
    source: NodeJS.ProcessEnv = env,
): AuthTokenCleanupConfig {
    const fallback = parseScheduleDuration(RETENTION_DEFAULT)
    const raw = source['AUTH_TOKEN_RETENTION']?.trim() ?? ''
    if (raw === '') return { retentionMs: fallback, configError: null }
    try {
        return { retentionMs: parseScheduleDuration(raw), configError: null }
    } catch (error: unknown) {
        return {
            retentionMs: fallback,
            configError: `AUTH_TOKEN_RETENTION: ${(error as Error).message}`,
        }
    }
}

export default Object.freeze(readAuthTokenCleanupConfig())
