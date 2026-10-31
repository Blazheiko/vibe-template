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

export default Object.freeze({
    storage: 'redis',
    cookieName,
    legacyCookieName: LEGACY_COOKIE_NAME,
    useHostPrefix,
    age: Math.floor(duration('24h') / 1000), // d - days, h - hours, m - minutes, s - seconds
    /** Lifetime of an anonymous session, in seconds (SESSION_ANON_TTL, default 2h). */
    anonAge: readAnonAge(),

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
