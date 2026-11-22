import { createHash, createHmac, randomBytes } from 'node:crypto'

import redis, { withRedis } from '#database/redis.js'
import appConfig from '#config/app.js'
import type { LoginOrigin, LoginPlan } from '#vendor/types/types.js'
import { sanitizeRedisKey } from '#vendor/utils/session/redis-session-storage.js'

// feat-245 (docs/plan/passkeys-mfa-plan.md, Р4): the one-time ticket between the first factor and
// the second. It lives in Redis under the hash of a random id that only the browser holds (an
// HttpOnly cookie), and is bound to that browser's session cookie.
//
// States: `open` (attempts may run) → `completing` (one attempt won; the plan of the session and
// the transaction id are stored) → `activated` (the session exists) → deleted. A known rollback
// takes `completing` back to `open`.
//
// The attempt limit counts proofs found wrong (`failures`), not requests: an attempt holds a
// reservation while it runs, and an attempt that never got its proof checked gives it back. A
// reservation older than the reservation TTL is abandoned (a process that stopped) and dropped.
// Every reservation is accounted once (`settled`).

export const MFA_MAX_FAILURES = 5

export interface PendingOAuthLink {
    provider: string
    providerUserId: string
    providerEmail: string | null
    providerName: string | null
    providerAvatar: string | null
}

export interface MfaTicket {
    v: 1
    state: 'open' | 'completing' | 'activated'
    userId: string
    userTokenAtStart: string
    binding: string
    origin: Exclude<LoginOrigin, { inherit: unknown }>
    /** The first factor, as an `amr` of the session. */
    firstFactor: 'pwd' | 'oauth'
    redirect?: string | null
    pendingOAuthLink?: PendingOAuthLink | null
    failures: number
    reservations: { id: string; at: number }[]
    settled: string[]
    completionId?: string
    xid?: string
    plan?: LoginPlan
    sessionId?: string
}

/** The Redis key of a ticket: the hash of its id, so a leaked key opens nothing. */
export const mfaTicketKey = (ticketId: string): string =>
    `auth:mfa:${createHash('sha256').update(ticketId).digest('base64url')}`

export const newTicketId = (): string => randomBytes(32).toString('base64url')

/** The browser binding (Р4): a keyed hash of the session id the browser's cookie names. */
export const mfaBinding = (sessionId: string): string =>
    createHmac('sha256', appConfig.key ?? '')
        .update(`mfa-binding:${sessionId}`)
        .digest('base64url')

// Lua: cjson turns an empty array into an empty object; the TS side normalizes both.
const LUA_COMMON = `
local function load(key)
  local raw = redis.call('GET', key)
  if not raw then return nil end
  local ok, ticket = pcall(cjson.decode, raw)
  if not ok or type(ticket) ~= 'table' then return nil end
  if type(ticket.reservations) ~= 'table' then ticket.reservations = {} end
  if type(ticket.settled) ~= 'table' then ticket.settled = {} end
  return ticket
end
local function save(key, ticket)
  redis.call('SET', key, cjson.encode(ticket), 'KEEPTTL')
end
local function live(ticket, now, ttl)
  local kept = {}
  for _, r in ipairs(ticket.reservations) do
    if now - r.at < ttl then table.insert(kept, r) end
  end
  ticket.reservations = kept
end
local function holds(ticket, id)
  for i, r in ipairs(ticket.reservations) do
    if r.id == id then return i end
  end
  return nil
end
local function wasSettled(ticket, id)
  for _, s in ipairs(ticket.settled) do
    if s == id then return true end
  end
  return false
end
local function settle(ticket, id)
  local i = holds(ticket, id)
  if i then table.remove(ticket.reservations, i) end
  table.insert(ticket.settled, id)
end
`

/**
 * KEYS: ticket. ARGV: binding, now (ms), reservation TTL (ms), max failures, reservation id.
 * Answers [outcome, ticket JSON]: `ok` (a reservation is held), `busy` (failures + reservations
 * at the limit), `invalid` (no ticket, or another browser), or the state when it is not `open`.
 */
const RESERVE_LUA = `${LUA_COMMON}
local ticket = load(KEYS[1])
if not ticket or ticket.binding ~= ARGV[1] then return {'invalid', ''} end
if ticket.state ~= 'open' then return {ticket.state, cjson.encode(ticket)} end
local now = tonumber(ARGV[2])
live(ticket, now, tonumber(ARGV[3]))
if ticket.failures + #ticket.reservations >= tonumber(ARGV[4]) then
  save(KEYS[1], ticket)
  return {'busy', cjson.encode(ticket)}
end
table.insert(ticket.reservations, { id = ARGV[5], at = now })
save(KEYS[1], ticket)
return {'ok', cjson.encode(ticket)}
`

/**
 * KEYS: ticket. ARGV: reservation id, outcome (`failure` | `release`), max failures. A failure
 * counts even when its reservation expired meanwhile; a release gives the place back. Accounted
 * once per reservation. Answers `deleted` when the fifth confirmed failure removed the ticket.
 */
const SETTLE_LUA = `${LUA_COMMON}
local ticket = load(KEYS[1])
if not ticket then return 'gone' end
if wasSettled(ticket, ARGV[1]) then return 'settled' end
settle(ticket, ARGV[1])
if ARGV[2] == 'failure' then
  ticket.failures = ticket.failures + 1
  if ticket.failures >= tonumber(ARGV[3]) then
    redis.call('DEL', KEYS[1])
    return 'deleted'
  end
end
save(KEYS[1], ticket)
return 'ok'
`

/**
 * KEYS: ticket. ARGV: reservation id, now (ms), reservation TTL (ms), completion id, xid, plan
 * JSON. The attempt wins only while the ticket is `open` and its reservation is live: `ok`,
 * `used` (another attempt won), `expired` (the reservation lapsed) or `gone`.
 */
const CAPTURE_LUA = `${LUA_COMMON}
local ticket = load(KEYS[1])
if not ticket then return 'gone' end
if ticket.state ~= 'open' then return 'used' end
live(ticket, tonumber(ARGV[2]), tonumber(ARGV[3]))
if not holds(ticket, ARGV[1]) or wasSettled(ticket, ARGV[1]) then
  save(KEYS[1], ticket)
  return 'expired'
end
settle(ticket, ARGV[1])
ticket.state = 'completing'
ticket.completionId = ARGV[4]
ticket.xid = ARGV[5]
ticket.plan = cjson.decode(ARGV[6])
save(KEYS[1], ticket)
return 'ok'
`

/** KEYS: ticket. ARGV: completion id. A known rollback: `completing` back to `open`. */
const REOPEN_LUA = `${LUA_COMMON}
local ticket = load(KEYS[1])
if not ticket or ticket.state ~= 'completing' or ticket.completionId ~= ARGV[1] then return 0 end
ticket.state = 'open'
ticket.completionId = nil
ticket.xid = nil
ticket.plan = nil
save(KEYS[1], ticket)
return 1
`

/** KEYS: ticket. ARGV: completion id. Deletes the ticket once its session is in use. */
const RETIRE_LUA = `${LUA_COMMON}
local ticket = load(KEYS[1])
if not ticket or ticket.completionId ~= ARGV[1] then return 0 end
redis.call('DEL', KEYS[1])
return 1
`

const asArray = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : [])

const parseTicket = (raw: string): MfaTicket | null => {
    try {
        const ticket = JSON.parse(raw) as MfaTicket
        return {
            ...ticket,
            reservations: asArray(ticket.reservations),
            settled: asArray(ticket.settled),
        }
    } catch {
        return null
    }
}

const key = (ticketId: string): string => sanitizeRedisKey(mfaTicketKey(ticketId))

export type ReserveOutcome =
    | { kind: 'ok'; ticket: MfaTicket }
    | { kind: 'busy' | 'invalid' }
    | { kind: 'completing' | 'activated'; ticket: MfaTicket }

export const mfaTicketStore = {
    async create(ticketId: string, ticket: MfaTicket, ttlSeconds: number): Promise<void> {
        await withRedis(() => redis.set(key(ticketId), JSON.stringify(ticket), 'EX', ttlSeconds))
    },

    async read(ticketId: string): Promise<MfaTicket | null> {
        const raw = await withRedis(() => redis.get(key(ticketId)))
        return raw === null ? null : parseTicket(raw)
    },

    /** Remaining lifetime in seconds (0 when gone). */
    async ttl(ticketId: string): Promise<number> {
        const seconds = await withRedis(() => redis.ttl(key(ticketId)))
        return seconds > 0 ? seconds : 0
    },

    async reserve(
        ticketId: string,
        binding: string,
        reservationId: string,
        now: number,
        reservationTtlMs: number,
    ): Promise<ReserveOutcome> {
        const [outcome, json] = (await withRedis(() =>
            redis.eval(
                RESERVE_LUA,
                1,
                key(ticketId),
                binding,
                String(now),
                String(reservationTtlMs),
                String(MFA_MAX_FAILURES),
                reservationId,
            ),
        )) as [string, string]
        if (outcome === 'busy' || outcome === 'invalid') return { kind: outcome }
        const ticket = parseTicket(json)
        if (ticket === null) return { kind: 'invalid' }
        if (outcome === 'completing' || outcome === 'activated') return { kind: outcome, ticket }
        if (outcome === 'ok') return { kind: 'ok', ticket }
        return { kind: 'invalid' }
    },

    async settle(
        ticketId: string,
        reservationId: string,
        outcome: 'failure' | 'release',
    ): Promise<'ok' | 'deleted' | 'settled' | 'gone'> {
        return (await withRedis(() =>
            redis.eval(
                SETTLE_LUA,
                1,
                key(ticketId),
                reservationId,
                outcome,
                String(MFA_MAX_FAILURES),
            ),
        )) as 'ok' | 'deleted' | 'settled' | 'gone'
    },

    async capture(
        ticketId: string,
        reservationId: string,
        now: number,
        reservationTtlMs: number,
        completion: { completionId: string; xid: string; plan: LoginPlan },
    ): Promise<'ok' | 'used' | 'expired' | 'gone'> {
        return (await withRedis(() =>
            redis.eval(
                CAPTURE_LUA,
                1,
                key(ticketId),
                reservationId,
                String(now),
                String(reservationTtlMs),
                completion.completionId,
                completion.xid,
                JSON.stringify(completion.plan),
            ),
        )) as 'ok' | 'used' | 'expired' | 'gone'
    },

    async reopen(ticketId: string, completionId: string): Promise<boolean> {
        const done = await withRedis(() => redis.eval(REOPEN_LUA, 1, key(ticketId), completionId))
        return Number(done) === 1
    },

    async retire(ticketId: string, completionId: string): Promise<boolean> {
        const done = await withRedis(() => redis.eval(RETIRE_LUA, 1, key(ticketId), completionId))
        return Number(done) === 1
    },

    async delete(ticketId: string): Promise<void> {
        await withRedis(() => redis.del(key(ticketId)))
    },

    /** The key the activation transition reads (sanitized by the session store itself). */
    keyOf: mfaTicketKey,
}
