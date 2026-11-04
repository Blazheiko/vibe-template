import type { DestroyAllSessionsResult, SessionData, SessionInfo } from '#vendor/types/types.js'
import redis, { withRedis } from '#database/redis.js'
import { RedisUnavailableError } from '#vendor/utils/network/errors/redis-unavailable-error.js'
import logger from '#vendor/utils/logger.js'
import { maskTokenForLogs } from '#vendor/utils/helpers/mask-sensitive.js'
import redisConfig from '#config/redis.js'
import { storedSessionTtl } from '#vendor/utils/session/session-ttl.js'

/**
 * Sanitizes Redis keys for protection against injections
 */
const MAX_KEY_LENGTH = 86
export const sanitizeRedisKey = (key: string | undefined | null): string => {
    if (
        key === undefined ||
        key === null ||
        key === '' ||
        key.length > MAX_KEY_LENGTH ||
        !/^[a-zA-Z0-9:_*-]+$/.test(key)
    ) {
        // feat-111: a session key holds the user token; only its shape is logged.
        logger.error(
            { keyLength: typeof key === 'string' ? key.length : 0 },
            `Invalid Redis key format`,
        )
        throw new Error(`Invalid Redis key format`)
    }
    return key
}

// Every command goes through withRedis: while Redis is down it fails fast with
// RedisUnavailableError, and the client neither queues nor resends commands, so
// a stale SETEX snapshot cannot overwrite a newer session after a reconnect.
// DEL is idempotent: a failed logout is simply repeated by the client.

/**
 * Cookie refresh marker of a session, kept apart from the session record: claiming
 * it never writes the session, so it cannot bring back one that another request
 * deleted meanwhile. True when this request should re-send the cookie.
 */
export const claimCookieRefresh = async (
    sessionId: string,
    ttlSeconds: number,
): Promise<boolean> => {
    const key = sanitizeRedisKey(`session_cookie_refresh:${sessionId}`)
    return (await withRedis(() => redis.set(key, '1', 'EX', ttlSeconds, 'NX'))) === 'OK'
}

/** Marks the cookie of a new session as just issued. */
export const markCookieIssued = async (sessionId: string, ttlSeconds: number): Promise<void> => {
    const key = sanitizeRedisKey(`session_cookie_refresh:${sessionId}`)
    await withRedis(() => redis.set(key, '1', 'EX', ttlSeconds))
}

// A cookie-held anonymous session has no record a late response could check, so login
// leaves this marker for its id (feat-057): a slower response of the same anonymous
// session must not re-issue that cookie over the login's one.
export const markAnonSessionSuperseded = async (
    sessionId: string,
    ttlSeconds: number,
): Promise<void> => {
    const key = sanitizeRedisKey(`session_superseded:${sessionId}`)
    await withRedis(() => redis.set(key, '1', 'EX', ttlSeconds))
}

/** Whether a login has replaced this anonymous session (its marker is set). */
export const anonSessionSignedIn = async (sessionId: string): Promise<boolean> => {
    const key = sanitizeRedisKey(`session_superseded:${sessionId}`)
    return (await withRedis(() => redis.exists(key))) === 1
}

/** Whether a cookie-held anonymous session was signed in from or moved to Redis. */
export const anonSessionSuperseded = async (sessionId: string): Promise<boolean> => {
    const superseded = sanitizeRedisKey(`session_superseded:${sessionId}`)
    const stored = sanitizeRedisKey(`session:anon_session:${sessionId}`)
    return (await withRedis(() => redis.exists(superseded, stored))) > 0
}

/** Whether the session record still exists; unlike getSession it does not extend its TTL. */
export const sessionExists = async (sessionId: string, userToken: string): Promise<boolean> => {
    const key = sanitizeRedisKey(`session:${userToken}:${sessionId}`)
    return (await withRedis(() => redis.exists(key))) === 1
}

export const saveSession = async (sessionInfo: SessionInfo): Promise<void> => {
    // Authenticated sessions use the user's nanoid token; anonymous sessions use shared prefix
    const userToken =
        typeof sessionInfo.data.userToken === 'string' ? sessionInfo.data.userToken : 'anon_session'
    const redisKey = sanitizeRedisKey(`session:${userToken}:${sessionInfo.id}`)

    const json = serializeSession(sessionInfo)
    await withRedis(() => redis.setex(redisKey, storedSessionTtl(userToken), json))
}

export const getSession = async (
    sessionId: string | undefined,
    userToken: string,
): Promise<SessionInfo | null> => {
    if (sessionId === undefined) return null

    const redisKey = sanitizeRedisKey(`session:${userToken}:${sessionId}`)

    const sessionJson = await withRedis(() =>
        redis.getex(redisKey, 'EX', storedSessionTtl(userToken)),
    )

    if (sessionJson === null) return null

    try {
        return JSON.parse(sessionJson) as SessionInfo
    } catch (e) {
        logger.error({ err: e }, 'Failed to parse session JSON:')
    }
    return null
}

// feat-111: an update writes back only over the very record it read, in one Lua script. A key
// that is gone stays gone (an update cannot bring back a session a logout deleted), and a record
// another request changed meanwhile is read again and the change applied to it (no lost update).
const COMPARE_AND_SET_LUA = `
local current = redis.call('GET', KEYS[1])
if not current then
  return -1
end
if current ~= ARGV[1] then
  return 0
end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
return 1
`
const MAX_UPDATE_ATTEMPTS = 3

export class SessionUpdateConflictError extends Error {
    constructor() {
        super('Session record kept changing during the update')
        this.name = 'SessionUpdateConflictError'
    }
}

const serializeSession = (sessionInfo: SessionInfo): string =>
    JSON.stringify(sessionInfo, (_, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))

const writeSessionUpdate = async (
    sessionId: string | undefined,
    userToken: string,
    apply: (session: SessionInfo) => SessionData,
): Promise<SessionInfo | null> => {
    if (sessionId === undefined) return null
    const redisKey = sanitizeRedisKey(`session:${userToken}:${sessionId}`)

    for (let attempt = 0; attempt < MAX_UPDATE_ATTEMPTS; attempt += 1) {
        const currentJson = await withRedis(() => redis.get(redisKey))
        if (currentJson === null) return null

        let session: SessionInfo
        try {
            session = JSON.parse(currentJson) as SessionInfo
        } catch (e) {
            logger.error({ err: e }, 'Failed to parse session JSON:')
            return null
        }

        const updatedSession: SessionInfo = {
            ...session,
            data: apply(session),
            updatedAt: new Date().toISOString(),
        }
        // Normalized once, so the result handed back is what the record holds (undefined fields
        // dropped, as before).
        const updatedJson = serializeSession(updatedSession)
        const outcome = Number(
            await withRedis(() =>
                redis.eval(
                    COMPARE_AND_SET_LUA,
                    1,
                    redisKey,
                    currentJson,
                    updatedJson,
                    String(storedSessionTtl(userToken)),
                ),
            ),
        )
        if (outcome === -1) return null
        if (outcome === 1) return JSON.parse(updatedJson) as SessionInfo
    }

    logger.warn({ attempts: MAX_UPDATE_ATTEMPTS }, 'Session update kept conflicting')
    throw new SessionUpdateConflictError()
}

/** Merges into the session data; null when the record is gone (it is not recreated). */
export const updateSessionData = async (
    sessionId: string | undefined,
    newData: SessionData,
    userToken: string,
): Promise<SessionInfo | null> =>
    await writeSessionUpdate(sessionId, userToken, (session) => ({ ...session.data, ...newData }))

/** Replaces the session data; null when the record is gone (it is not recreated). */
export const changeSessionData = async (
    sessionId: string | undefined,
    newData: SessionData,
    userToken: string,
): Promise<SessionInfo | null> => await writeSessionUpdate(sessionId, userToken, () => newData)

export const destroySession = async (
    sessionId: string | undefined,
    userToken: string,
): Promise<void> => {
    if (sessionId === undefined) return
    const redisKey = sanitizeRedisKey(`session:${userToken}:${sessionId}`)
    await withRedis(() => redis.del(redisKey))
}

/**
 * Rejects when `promise` takes longer than `ms`. The command may still run on
 * the server; the callers below only use it for idempotent SCAN/DEL.
 */
const withTimer = async <T>(promise: Promise<T>, ms: number): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const expired = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            reject(new RedisUnavailableError('logoutAll deadline exceeded'))
        }, ms)
    })
    try {
        return await Promise.race([promise, expired])
    } finally {
        clearTimeout(timer)
    }
}

/**
 * Deletes every session of the user: SCAN from cursor 0 over `session:<userToken>:*`, a DEL
 * per page. The whole loop is bounded by REDIS_LOGOUT_ALL_DEADLINE_MS.
 *
 * ADR 0002: this is memory cleanup, not the revocation; the caller has already rotated
 * users.session_token, so every record left is rejected anyway and expires by TTL. Hence an
 * unavailable Redis or the deadline does not reject: the result says `complete: false` and
 * a warning is logged. Any other error (a bug) is rethrown.
 */
export const destroyAllSessions = async (userToken: string): Promise<DestroyAllSessionsResult> => {
    const prefix = redisConfig.keyPrefix
    const pattern = sanitizeRedisKey(`${prefix}session:${userToken}:*`)
    logger.info({ userToken: maskTokenForLogs(userToken) }, 'Destroying all sessions for userToken')
    const deadline = Date.now() + redisConfig.logoutAllDeadlineMs
    // Each await gets what is left of the budget, capped by the command timeout,
    // so the loop ends near the deadline, not deadline + one command timeout.
    const step = async <T>(op: () => Promise<T>): Promise<T> => {
        const remaining = deadline - Date.now()
        if (remaining <= 0) {
            throw new RedisUnavailableError('logoutAll deadline exceeded')
        }
        return withTimer(withRedis(op), Math.min(remaining, redisConfig.commandTimeoutMs))
    }

    // Use SCAN instead of KEYS for DoS protection
    // SCAN doesn't block Redis and is safe for production
    let deleted = 0

    try {
        let cursor = '0'
        do {
            const [nextCursor, foundKeys] = await step(() =>
                redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100),
            )
            // Remove the prefix from keys since redis.del will add it automatically
            const keys = removePrefixFromKeys(foundKeys, prefix)
            if (keys.length > 0) {
                deleted += await step(() => redis.del(...keys))
            }
            cursor = nextCursor
        } while (cursor !== '0')
    } catch (err: unknown) {
        if (!(err instanceof RedisUnavailableError)) throw err
        logger.warn(
            { userToken: maskTokenForLogs(userToken), deleted },
            'Stopped deleting all sessions: Redis unavailable or deadline exceeded',
        )
        return { deleted, complete: false }
    }

    logger.info(
        { userToken: maskTokenForLogs(userToken), deleted },
        'Deleted all sessions for userToken',
    )

    return { deleted, complete: true }
}

const removePrefixFromKeys = (keys: string[], prefix: string): string[] => {
    return keys.map((key) => (key.startsWith(prefix) ? key.substring(prefix.length) : key))
}

// export default () => ({ saveSession, getSession, updateSessionData, changeSessionData, destroySession });
