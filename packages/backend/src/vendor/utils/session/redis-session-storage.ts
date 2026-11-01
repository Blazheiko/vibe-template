import type { SessionData, SessionInfo } from '#vendor/types/types.js'
import redis, { withRedis } from '#database/redis.js'
import { RedisUnavailableError } from '#vendor/utils/network/errors/redis-unavailable-error.js'
import logger from '#vendor/utils/logger.js'
import { maskTokenForLogs } from '#vendor/utils/helpers/mask-sensitive.js'
import sessionConfig from '#config/session.js'
import redisConfig from '#config/redis.js'

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
        logger.error({ key }, `Invalid Redis key format`)
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

// Anonymous sessions stored in Redis (they hold data, e.g. OAuth state) expire like the
// cookie-held ones; signed-in sessions keep the full age.
const ttlFor = (userToken: string): number =>
    userToken === 'anon_session' ? sessionConfig.anonAge : sessionConfig.age

export const saveSession = async (sessionInfo: SessionInfo): Promise<void> => {
    // Authenticated sessions use the user's nanoid token; anonymous sessions use shared prefix
    const userToken =
        typeof sessionInfo.data.userToken === 'string' ? sessionInfo.data.userToken : 'anon_session'
    const redisKey = sanitizeRedisKey(`session:${userToken}:${sessionInfo.id}`)

    const json = JSON.stringify(sessionInfo, (_, v: unknown) =>
        typeof v === 'bigint' ? v.toString() : v,
    )
    await withRedis(() => redis.setex(redisKey, ttlFor(userToken), json))
}

export const getSession = async (
    sessionId: string | undefined,
    userToken: string,
): Promise<SessionInfo | null> => {
    if (sessionId === undefined) return null

    const redisKey = sanitizeRedisKey(`session:${userToken}:${sessionId}`)

    const sessionJson = await withRedis(() => redis.getex(redisKey, 'EX', ttlFor(userToken)))

    if (sessionJson === null) return null

    try {
        return JSON.parse(sessionJson) as SessionInfo
    } catch (e) {
        logger.error({ err: e }, 'Failed to parse session JSON:')
    }
    return null
}

export const updateSessionData = async (
    sessionId: string | undefined,
    newData: SessionData,
    userToken: string,
): Promise<SessionInfo | null> => {
    if (sessionId === undefined) return null
    const session = await getSession(sessionId, userToken)
    if (session === null) return null

    const updatedSession: SessionInfo = {
        ...session,
        data: { ...session.data, ...newData },
        updatedAt: new Date().toISOString(),
    }

    await saveSession(updatedSession)
    return updatedSession
}

export const changeSessionData = async (
    sessionId: string | undefined,
    newData: SessionData,
    userToken: string,
): Promise<SessionInfo | null> => {
    if (sessionId === undefined) return null
    const session = await getSession(sessionId, userToken)
    if (session === null) return null

    const updatedSession: SessionInfo = {
        ...session,
        data: newData,
        updatedAt: new Date().toISOString(),
    }

    await saveSession(updatedSession)
    return updatedSession
}

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

/** How long an unfinished logoutAll keeps its SCAN cursor for a repeat. */
const LOGOUT_ALL_CURSOR_TTL_SECONDS = 600

/**
 * Deletes every session of the user. Resolves with the count only when SCAN
 * reached cursor 0; otherwise (deadline REDIS_LOGOUT_ALL_DEADLINE_MS exhausted,
 * Redis unavailable) rejects with RedisUnavailableError.
 *
 * Two modes:
 * - Interactive logoutAll (`keepSessionId` = the caller's own session): the
 *   session is skipped and deleted only after the scan completes, so a repeat
 *   after a stop is still authenticated; the SCAN cursor is saved after each
 *   batch under a key of that session and a repeat resumes from it, so on a
 *   large keyspace repeats make progress. A SCAN cursor is not bound to a
 *   connection. Sessions created behind the saved cursor between attempts are
 *   not seen by the resumed scan.
 * - Full revocation (no `keepSessionId`, e.g. password reset): always scans
 *   from 0 and never reads or writes a cursor, so progress left by an
 *   interactive run (which skipped its own session) cannot hide a session.
 */
export const destroyAllSessions = async (
    userToken: string,
    keepSessionId?: string,
): Promise<number> => {
    const prefix = redisConfig.keyPrefix
    const pattern = sanitizeRedisKey(`${prefix}session:${userToken}:*`)
    const keepKey =
        keepSessionId !== undefined
            ? sanitizeRedisKey(`session:${userToken}:${keepSessionId}`)
            : undefined
    const cursorKey =
        keepSessionId !== undefined
            ? sanitizeRedisKey(`logout_all:cursor:${userToken}:${keepSessionId}`)
            : undefined
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
    let deletedCount = 0

    try {
        let cursor =
            cursorKey === undefined ? '0' : ((await step(() => redis.get(cursorKey))) ?? '0')
        do {
            const [nextCursor, foundKeys] = await step(() =>
                redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100),
            )
            // Remove the prefix from keys since redis.del will add it automatically
            const keys = removePrefixFromKeys(foundKeys, prefix).filter((key) => key !== keepKey)
            if (keys.length > 0) {
                deletedCount += await step(() => redis.del(...keys))
            }
            cursor = nextCursor
            // Saved after the DEL: a lost save only repeats an idempotent batch.
            if (cursorKey !== undefined && cursor !== '0') {
                await step(() => redis.setex(cursorKey, LOGOUT_ALL_CURSOR_TTL_SECONDS, cursor))
            }
        } while (cursor !== '0')

        // Cursor and the kept session go together (MULTI): a stop between two
        // separate DELs would leave either a full rescan from 0 or an
        // unauthenticated client with sessions left.
        if (keepKey !== undefined && cursorKey !== undefined) {
            const results = await step(() => redis.multi().del(cursorKey).del(keepKey).exec())
            const keptDeleted = results?.[1]?.[1]
            deletedCount += typeof keptDeleted === 'number' ? keptDeleted : 0
        }
    } catch (err: unknown) {
        if (err instanceof RedisUnavailableError) {
            logger.warn(
                { userToken: maskTokenForLogs(userToken), deletedCount },
                'Stopped deleting all sessions: Redis unavailable or deadline exceeded',
            )
        }
        throw err
    }

    logger.info(
        { userToken: maskTokenForLogs(userToken), deletedCount },
        'Deleted all sessions for userToken',
    )

    return deletedCount
}

const removePrefixFromKeys = (keys: string[], prefix: string): string[] => {
    return keys.map((key) => (key.startsWith(prefix) ? key.substring(prefix.length) : key))
}

// export default () => ({ saveSession, getSession, updateSessionData, changeSessionData, destroySession });
