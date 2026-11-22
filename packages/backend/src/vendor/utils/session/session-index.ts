import type { SessionInfo } from '#vendor/types/types.js'
import redis, { withRedis } from '#database/redis.js'
import sessionConfig from '#config/session.js'
import logger from '#vendor/utils/logger.js'
import { maskTokenForLogs } from '#vendor/utils/helpers/mask-sensitive.js'
import { isPastMaxAge } from '#vendor/utils/session/session-age.js'
import { storedSessionTtl } from '#vendor/utils/session/session-ttl.js'
import { isAfter, type IndexPosition } from '#vendor/utils/session/session-page-cursor.js'

// feat-233 (Р2): the sessions of a user, for the session list. Two keys per users.session_token,
// changed together with the session record by the Lua scripts below:
//
// - `session_index:<userToken>`: ZSET publicId -> createdAt (ms) of the record. The member is the
//   public id (Р5), so a page cursor discloses nothing; the score never changes while it lives.
// - `session_meta:<userToken>`: HASH publicId -> JSON { sid, seen }: the session id (to delete the
//   record) and lastSeenAt (Р4). A member and its field always come and go together.
//
// Why Lua and not MULTI: neither rolls back the commands already run when a later one fails (for
// example with WRONGTYPE). A script can check the type of every key first and write only after
// that, and then no write fails with WRONGTYPE. So creation and deletion run whole or not at all,
// as long as (a) the type check passed, (b) the script is not cut short by a server stop (a
// script that has written cannot be stopped by SCRIPT KILL), (c) Redis does not crash mid-script
// without persistence. Outside those a session may miss the list, but "end all other sessions"
// still ends it through the token rotation (ADR 0002).
//
// A wrong key type fails the sign-in before anything is written (closed failure, logged as an
// error); the script does not delete the key and go on, which would hide live sessions.
//
// Redis Cluster: a multi-key script needs its keys in one slot. If a cluster is ever configured,
// these keys and the record need a common hash tag such as `{<userToken>}`.

const TYPE_CHECK = `
local function wrongType(key, expected)
  local t = redis.call('TYPE', key)['ok']
  return t ~= 'none' and t ~= expected
end
local function publicIdOf(raw)
  if not raw then return nil end
  local ok, record = pcall(cjson.decode, raw)
  if not ok or type(record) ~= 'table' or type(record.data) ~= 'table' then return nil end
  local device = record.data.device
  if type(device) ~= 'table' or type(device.publicId) ~= 'string' then return nil end
  return device.publicId
end
local function dropMembers(index, meta, members)
  for i = 1, #members, 500 do
    local chunk = {unpack(members, i, math.min(i + 499, #members))}
    redis.call('ZREM', index, unpack(chunk))
    redis.call('HDEL', meta, unpack(chunk))
  end
end
`

/**
 * KEYS: record, index, meta. ARGV: record JSON, record TTL (s), publicId, createdAt (ms), meta
 * JSON, members created before this (ms) are dropped, TTL of the index and meta (s).
 */
const SESSION_CREATE_LUA = `${TYPE_CHECK}
if wrongType(KEYS[1], 'string') or wrongType(KEYS[2], 'zset') or wrongType(KEYS[3], 'hash') then
  return redis.error_reply('WRONGTYPE session record, index or meta key holds another type')
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
dropMembers(KEYS[2], KEYS[3], redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', '(' .. ARGV[6]))
redis.call('ZADD', KEYS[2], ARGV[4], ARGV[3])
redis.call('HSET', KEYS[3], ARGV[3], ARGV[5])
redis.call('EXPIRE', KEYS[2], ARGV[7])
redis.call('EXPIRE', KEYS[3], ARGV[7])
return 1
`

/**
 * KEYS: index, meta, and the record when its session id is known. ARGV: publicId, or '' to read
 * it from the record. Answers how many records it deleted (0 or 1). Idempotent.
 */
const SESSION_DESTROY_LUA = `${TYPE_CHECK}
if wrongType(KEYS[1], 'zset') or wrongType(KEYS[2], 'hash') or (KEYS[3] and wrongType(KEYS[3], 'string')) then
  return redis.error_reply('WRONGTYPE session record, index or meta key holds another type')
end
local publicId = ARGV[1]
local removed = 0
if KEYS[3] then
  if publicId == '' then publicId = publicIdOf(redis.call('GET', KEYS[3])) or '' end
  removed = redis.call('DEL', KEYS[3])
end
if publicId ~= '' then
  redis.call('ZREM', KEYS[1], publicId)
  redis.call('HDEL', KEYS[2], publicId)
end
return removed
`

/**
 * KEYS: record, meta. ARGV: now (ms). Writes `seen` only while the record exists and its field is
 * there; it keeps the TTL and creates nothing, so a touch after a deletion or a rotation brings
 * nothing back. Answers 1 when the field holds a time at least this new.
 */
const SESSION_TOUCH_LUA = `${TYPE_CHECK}
if wrongType(KEYS[1], 'string') or wrongType(KEYS[2], 'hash') then
  return redis.error_reply('WRONGTYPE session record or meta key holds another type')
end
local publicId = publicIdOf(redis.call('GET', KEYS[1]))
if not publicId then return 0 end
local current = redis.call('HGET', KEYS[2], publicId)
if not current then return 0 end
local ok, meta = pcall(cjson.decode, current)
if not ok or type(meta) ~= 'table' or type(meta.sid) ~= 'string' then return 0 end
if type(meta.seen) == 'number' and meta.seen >= tonumber(ARGV[1]) then return 1 end
redis.call('HSET', KEYS[2], publicId, '{"sid":' .. cjson.encode(meta.sid) .. ',"seen":' .. ARGV[1] .. '}')
return 1
`

const DAY_SECONDS = 24 * 60 * 60

export const recordKey = (userToken: string, sessionId: string): string =>
    `session:${userToken}:${sessionId}`
export const indexKey = (userToken: string): string => `session_index:${userToken}`
export const metaKey = (userToken: string): string => `session_meta:${userToken}`

interface SessionMeta {
    sid: string
    seen: number | null
}

const parseMeta = (raw: string | null): SessionMeta | null => {
    if (raw === null) return null
    try {
        const value = JSON.parse(raw) as unknown
        if (typeof value !== 'object' || value === null) return null
        const { sid, seen } = value as Record<string, unknown>
        if (typeof sid !== 'string' || sid === '') return null
        return { sid, seen: typeof seen === 'number' && Number.isFinite(seen) ? seen : null }
    } catch {
        return null
    }
}

const serialize = (sessionInfo: SessionInfo): string =>
    JSON.stringify(sessionInfo, (_, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))

/**
 * Writes a new signed-in session with its index member and meta field, in one script (Р2). Members
 * older than SESSION_MAX_AGE_DAYS are dropped on the way; both keys live SESSION_MAX_AGE_DAYS from
 * this sign-in. `sanitize` checks the keys (the store's key rule).
 */
export const createIndexedSession = async (
    session: SessionInfo,
    userToken: string,
    publicId: string,
    createdAtMs: number,
    sanitize: (key: string) => string,
): Promise<void> => {
    const maxAgeSeconds = sessionConfig.maxAgeDays * DAY_SECONDS
    await withRedis(() =>
        redis.eval(
            SESSION_CREATE_LUA,
            3,
            sanitize(recordKey(userToken, session.id)),
            sanitize(indexKey(userToken)),
            sanitize(metaKey(userToken)),
            serialize(session),
            String(storedSessionTtl(userToken)),
            publicId,
            String(createdAtMs),
            JSON.stringify({ sid: session.id, seen: createdAtMs }),
            String(createdAtMs - maxAgeSeconds * 1000),
            String(maxAgeSeconds),
        ),
    )
}

/**
 * Deletes a signed-in session: its record, index member and meta field (Р2). `publicId` may be
 * left out when the record still holds it. `sessionId` may be left out to drop only a dead member.
 * Answers whether a record was deleted.
 */
export const destroyIndexedSession = async (
    userToken: string,
    target: { sessionId?: string; publicId?: string },
    sanitize: (key: string) => string,
): Promise<boolean> => {
    const keys = [sanitize(indexKey(userToken)), sanitize(metaKey(userToken))]
    if (target.sessionId !== undefined) keys.push(sanitize(recordKey(userToken, target.sessionId)))
    const removed = await withRedis(() =>
        redis.eval(SESSION_DESTROY_LUA, keys.length, ...keys, target.publicId ?? ''),
    )
    return Number(removed) === 1
}

/** Writes lastSeenAt of a live session (Р4); false when the session or its field is gone. */
export const touchIndexedSession = async (
    userToken: string,
    sessionId: string,
    nowMs: number,
    sanitize: (key: string) => string,
): Promise<boolean> => {
    const touched = await withRedis(() =>
        redis.eval(
            SESSION_TOUCH_LUA,
            2,
            sanitize(recordKey(userToken, sessionId)),
            sanitize(metaKey(userToken)),
            String(nowMs),
        ),
    )
    return Number(touched) === 1
}

/** The session id and lastSeenAt of one public id, or null when the user has no such session. */
export const findIndexedSession = async (
    userToken: string,
    publicId: string,
    sanitize: (key: string) => string,
): Promise<SessionMeta | null> =>
    parseMeta(await withRedis(() => redis.hget(sanitize(metaKey(userToken)), publicId)))

export interface IndexedSession {
    publicId: string
    sessionId: string
    createdAtMs: number
    lastSeenAtMs: number | null
    info: SessionInfo
}

export interface SessionPage {
    sessions: IndexedSession[]
    /** Position of the last member looked at; null when the index is exhausted. */
    next: IndexPosition | null
}

/** Page limits (Р7): constants, not env. */
export const SESSION_PAGE_SIZE = 50
export const SESSION_PAGE_BATCH = 64
export const SESSION_PAGE_SCAN_LIMIT = 500

interface Member {
    publicId: string
    createdAtMs: number
}

/**
 * The next `limit` members after `after` (from the start when null), in index order, and whether
 * more may follow. Equal scores: Redis gives the group in reverse lexicographic order and cannot
 * filter it by member, so the whole group is read and cut here.
 */
const nextBatch = async (
    index: string,
    after: IndexPosition | null,
    limit: number,
): Promise<{ members: Member[]; more: boolean }> => {
    const toMembers = (flat: string[]): Member[] => {
        const members: Member[] = []
        for (let i = 0; i + 1 < flat.length; i += 2) {
            members.push({ publicId: flat[i] ?? '', createdAtMs: Number(flat[i + 1]) })
        }
        return members
    }
    if (after === null) {
        const flat = await withRedis(() =>
            redis.zrevrangebyscore(index, '+inf', '-inf', 'WITHSCORES', 'LIMIT', 0, limit + 1),
        )
        const members = toMembers(flat)
        return { members: members.slice(0, limit), more: members.length > limit }
    }
    const score = String(after.createdAtMs)
    const pipeline = redis.pipeline()
    pipeline.zrevrangebyscore(index, score, score)
    pipeline.zrevrangebyscore(index, `(${score}`, '-inf', 'WITHSCORES', 'LIMIT', 0, limit + 1)
    const replies = await withRedis(() => pipeline.exec())
    const [equalReply, restReply] = replies ?? []
    if (equalReply === undefined || restReply === undefined) {
        throw new Error('Session index read returned an incomplete answer')
    }
    if (equalReply[0] !== null) throw equalReply[0]
    if (restReply[0] !== null) throw restReply[0]
    const equal = (equalReply[1] as string[])
        .map((publicId) => ({ publicId, createdAtMs: after.createdAtMs }))
        .filter((member) => isAfter(member, after))
    const members = [...equal, ...toMembers(restReply[1] as string[])]
    return { members: members.slice(0, limit), more: members.length > limit }
}

/**
 * One page of live sessions after `after` (Р7). Every member looked at, live or dead, moves the
 * position; reading stops at SESSION_PAGE_SIZE live ones, the end of the index or
 * SESSION_PAGE_SCAN_LIMIT members looked at. A dead member (no meta field, no record, past
 * SESSION_MAX_AGE_DAYS) is dropped by the delete script and not returned. `excludePublicId` (the
 * current session) is skipped and moves the position like any other.
 */
export const listSessionPage = async (
    userToken: string,
    options: { after: IndexPosition | null; excludePublicId?: string | undefined },
    sanitize: (key: string) => string,
): Promise<SessionPage> => {
    const index = sanitize(indexKey(userToken))
    const meta = sanitize(metaKey(userToken))
    const sessions: IndexedSession[] = []
    const dead: { publicId: string; sessionId?: string }[] = []
    let position = options.after
    let scanned = 0
    let exhausted = false

    outer: while (sessions.length < SESSION_PAGE_SIZE && scanned < SESSION_PAGE_SCAN_LIMIT) {
        const limit = Math.min(SESSION_PAGE_BATCH, SESSION_PAGE_SCAN_LIMIT - scanned)
        const batch = await nextBatch(index, position, limit)
        if (batch.members.length === 0) {
            exhausted = true
            break
        }
        // Two steps: the record keys are known only from the meta fields. A session ended between
        // them is simply dead in the second.
        const metas = (
            await withRedis(() => redis.hmget(meta, ...batch.members.map((m) => m.publicId)))
        ).map(parseMeta)
        const pipeline = redis.pipeline()
        const withRecord: number[] = []
        metas.forEach((entry, i) => {
            if (entry === null) return
            withRecord.push(i)
            pipeline.get(sanitize(recordKey(userToken, entry.sid)))
        })
        const records = new Map<number, string | null>()
        if (withRecord.length > 0) {
            const replies = await withRedis(() => pipeline.exec())
            if (replies?.length !== withRecord.length) {
                throw new Error('Session record read returned an incomplete answer')
            }
            replies.forEach(([err, value], j) => {
                if (err !== null) throw err
                records.set(withRecord[j] ?? -1, typeof value === 'string' ? value : null)
            })
        }

        for (const [i, member] of batch.members.entries()) {
            scanned += 1
            position = { createdAtMs: member.createdAtMs, publicId: member.publicId }
            if (member.publicId === options.excludePublicId) continue
            const entry = metas[i] ?? null
            const info = parseRecord(records.get(i) ?? null)
            if (entry === null || info === null || isPastMaxAge(info.createdAt)) {
                dead.push({
                    publicId: member.publicId,
                    ...(entry !== null ? { sessionId: entry.sid } : {}),
                })
                continue
            }
            sessions.push({
                publicId: member.publicId,
                sessionId: entry.sid,
                createdAtMs: member.createdAtMs,
                lastSeenAtMs: entry.seen,
                info,
            })
            if (sessions.length >= SESSION_PAGE_SIZE) {
                if (i === batch.members.length - 1 && !batch.more) exhausted = true
                break outer
            }
        }
        if (!batch.more) {
            exhausted = true
            break
        }
    }

    await dropDeadMembers(userToken, dead, sanitize)
    return { sessions, next: exhausted ? null : position }
}

const parseRecord = (raw: string | null): SessionInfo | null => {
    if (raw === null) return null
    try {
        const info = JSON.parse(raw) as unknown
        if (typeof info !== 'object' || info === null) return null
        const { data } = info as { data?: unknown }
        return typeof data === 'object' && data !== null ? (info as SessionInfo) : null
    } catch {
        return null
    }
}

// Cleanup only: the page is right without it, so a failure is logged.
const dropDeadMembers = async (
    userToken: string,
    dead: readonly { publicId: string; sessionId?: string }[],
    sanitize: (key: string) => string,
): Promise<void> => {
    for (const member of dead) {
        try {
            await destroyIndexedSession(userToken, member, sanitize)
        } catch (err) {
            logger.warn(
                { err, userToken: maskTokenForLogs(userToken) },
                'Could not drop a dead member of the session index',
            )
            return
        }
    }
}

// ─── feat-245: a sign-in finished by the second step (docs/plan/passkeys-mfa-plan.md, Р4) ──────

/**
 * KEYS: record. ARGV: record JSON, TTL (s), completion id. Writes the pending record of a sign-in
 * not confirmed yet, or leaves the one this completion already wrote. A pending record is not in
 * the index and `restore` refuses it, so it opens nothing before the activation.
 */
const PENDING_PREPARE_LUA = `
local current = redis.call('GET', KEYS[1])
if current then
  local ok, record = pcall(cjson.decode, current)
  if ok and type(record) == 'table' and type(record.data) == 'table'
     and record.data.completionId == ARGV[3] then
    return 'exists'
  end
  return 'conflict'
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
return 'created'
`

/**
 * KEYS: ticket, record, index, meta. ARGV: completion id, final record JSON, record TTL (s),
 * publicId, createdAt (ms), meta JSON, members created before this (ms) are dropped, TTL of index
 * and meta (s), session id.
 *
 * The one transition that makes a second-step sign-in real (Р4): it reads the ticket as it is now,
 * and only while the ticket is `completing` for this completion writes the active record, its
 * index member and meta field and moves the ticket to `activated`. A request holding an older
 * snapshot gets `already` (nothing written) or `gone`, so it never brings back a record a logout
 * deleted after the activation.
 */
const PENDING_ACTIVATE_LUA = `${TYPE_CHECK}
local raw = redis.call('GET', KEYS[1])
if not raw then return {'gone', 0} end
local ok, ticket = pcall(cjson.decode, raw)
if not ok or type(ticket) ~= 'table' or ticket.completionId ~= ARGV[1] then return {'gone', 0} end
if ticket.state == 'activated' then return {'already', redis.call('EXISTS', KEYS[2])} end
if ticket.state ~= 'completing' then return {'gone', 0} end
if wrongType(KEYS[2], 'string') or wrongType(KEYS[3], 'zset') or wrongType(KEYS[4], 'hash') then
  return redis.error_reply('WRONGTYPE session record, index or meta key holds another type')
end
redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3])
dropMembers(KEYS[3], KEYS[4], redis.call('ZRANGEBYSCORE', KEYS[3], '-inf', '(' .. ARGV[7]))
redis.call('ZADD', KEYS[3], ARGV[5], ARGV[4])
redis.call('HSET', KEYS[4], ARGV[4], ARGV[6])
redis.call('EXPIRE', KEYS[3], ARGV[8])
redis.call('EXPIRE', KEYS[4], ARGV[8])
ticket.state = 'activated'
ticket.sessionId = ARGV[9]
redis.call('SET', KEYS[1], cjson.encode(ticket), 'KEEPTTL')
return {'activated', 1}
`

export const preparePendingSession = async (
    session: SessionInfo,
    userToken: string,
    ttlSeconds: number,
    completionId: string,
    sanitize: (key: string) => string,
): Promise<'created' | 'exists' | 'conflict'> => {
    const outcome = await withRedis(() =>
        redis.eval(
            PENDING_PREPARE_LUA,
            1,
            sanitize(recordKey(userToken, session.id)),
            serialize(session),
            String(Math.max(1, Math.ceil(ttlSeconds))),
            completionId,
        ),
    )
    return outcome as 'created' | 'exists' | 'conflict'
}

export type ActivationOutcome =
    { kind: 'activated' } | { kind: 'already'; recordExists: boolean } | { kind: 'gone' }

export const activatePendingSession = async (input: {
    ticketKey: string
    completionId: string
    session: SessionInfo
    userToken: string
    publicId: string
    createdAtMs: number
    sanitize: (key: string) => string
}): Promise<ActivationOutcome> => {
    const maxAgeSeconds = sessionConfig.maxAgeDays * DAY_SECONDS
    const { session, userToken, publicId, createdAtMs, sanitize } = input
    const result = (await withRedis(() =>
        redis.eval(
            PENDING_ACTIVATE_LUA,
            4,
            sanitize(input.ticketKey),
            sanitize(recordKey(userToken, session.id)),
            sanitize(indexKey(userToken)),
            sanitize(metaKey(userToken)),
            input.completionId,
            serialize(session),
            String(storedSessionTtl(userToken)),
            publicId,
            String(createdAtMs),
            JSON.stringify({ sid: session.id, seen: createdAtMs }),
            String(createdAtMs - maxAgeSeconds * 1000),
            String(maxAgeSeconds),
            session.id,
        ),
    )) as [string, number]
    if (result[0] === 'activated') return { kind: 'activated' }
    if (result[0] === 'already') return { kind: 'already', recordExists: result[1] === 1 }
    return { kind: 'gone' }
}
