import { duration } from 'metautil'
import { env } from 'node:process'

import appConfig from '#config/app.js'
import { parseBoolean } from '#vendor/utils/env/parse-boolean.js'

const LEGACY_COOKIE_NAME = 'uapi'
const HOST_PREFIXED_COOKIE_NAME = '__Host-uapi'

const useHostPrefix = parseBoolean(env['SESSION_COOKIE_HOST_PREFIX'], appConfig.isProductionLike)

const cookieName = useHostPrefix ? HOST_PREFIXED_COOKIE_NAME : LEGACY_COOKIE_NAME

// Anonymous sessions (feat-057) live in a signed cookie and reach Redis only when they
// store data; either way they expire after this, sliding with use.
const ANON_AGE_DEFAULT = '2h'
const readAnonAge = (): number => {
    const raw = env['SESSION_ANON_TTL']
    const seconds = Math.floor(
        duration(raw === undefined || raw === '' ? ANON_AGE_DEFAULT : raw) / 1000,
    )
    if (!Number.isFinite(seconds) || seconds <= 0) {
        throw new Error(
            `SESSION_ANON_TTL must be a positive duration (e.g. 2h, 30m), got "${String(raw)}"`,
        )
    }
    return seconds
}

// ADR 0002: every authenticated request waits for one users.session_token read. A
// database that accepts the connection but never answers must end in a 503, not in a
// request that waits forever (the pool only bounds the wait for a free connection).
const TOKEN_CHECK_TIMEOUT_DEFAULT_MS = 2000
const TOKEN_CHECK_TIMEOUT_MAX_MS = 60_000
export const readTokenCheckTimeoutMs = (source: NodeJS.ProcessEnv = env): number => {
    const raw = source['SESSION_TOKEN_CHECK_TIMEOUT_MS']
    if (raw === undefined || raw.trim() === '') return TOKEN_CHECK_TIMEOUT_DEFAULT_MS
    // Decimal digits only: Number() would also take "1e3" and "0x10".
    const value = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN
    if (!Number.isInteger(value) || value <= 0 || value > TOKEN_CHECK_TIMEOUT_MAX_MS) {
        throw new Error(
            `SESSION_TOKEN_CHECK_TIMEOUT_MS must be an integer from 1 to ${String(TOKEN_CHECK_TIMEOUT_MAX_MS)}, got "${raw}"`,
        )
    }
    return value
}

export default Object.freeze({
    storage: 'redis',
    cookieName,
    legacyCookieName: LEGACY_COOKIE_NAME,
    useHostPrefix,
    age: Math.floor(duration('24h') / 1000), // d - days, h - hours, m - minutes, s - seconds
    /** Lifetime of an anonymous session, in seconds (SESSION_ANON_TTL, default 2h). */
    anonAge: readAnonAge(),
    /** Deadline of the users.session_token lookup, in ms (SESSION_TOKEN_CHECK_TIMEOUT_MS, default 2000). */
    tokenCheckTimeoutMs: readTokenCheckTimeoutMs(),

    /**
     * Configuration for session cookie and the cookie store
     */
    cookie: {
        path: '/',
        httpOnly: true,
        secure: env['APP_ENV'] !== 'local',
        sameSite: 'Lax', // 'Strict' || 'Lax' . 'None' is not secure use only for CSRF protection
    },
})
