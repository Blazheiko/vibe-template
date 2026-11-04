import sessionConfig from '#config/session.js'

const MAX_CLOCK_SKEW_MS = 5 * 60_000
const DAY_MS = 24 * 60 * 60_000

/**
 * feat-111: a stored session lives at most SESSION_MAX_AGE_DAYS from its createdAt, however often
 * it is used (the TTL slides with every request). A createdAt that does not parse, or lies in the
 * future beyond the clock skew, cannot prove the age and ends the session too.
 *
 * feat-119 (F1): the one age check of every reader of a stored session. The session store applies
 * it in `getSession` (HTTP requests, every WebSocket message) and the WebSocket upgrade applies it
 * to the record it reads, so no path keeps a session alive past its lifetime.
 */
export const isPastMaxAge = (createdAt: unknown, now = Date.now()): boolean => {
    if (typeof createdAt !== 'string') return true
    const created = Date.parse(createdAt)
    if (Number.isNaN(created)) return true
    if (created - now > MAX_CLOCK_SKEW_MS) return true
    return now - created >= sessionConfig.maxAgeDays * DAY_MS
}
