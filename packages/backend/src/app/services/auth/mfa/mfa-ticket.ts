import { createHash } from 'node:crypto'
import { seconds, type Milliseconds, type Seconds, type UnixMs } from 'shared/brand'

import redis, { withRedis } from '#database/redis.js'
import { msArg, setWithTtlSeconds } from '#app/services/shared/redis-ttl.js'
import appConfig from '#config/app.js'
import {
    mfaAttemptIdOf,
    mfaBindingOf,
    newMfaBindValue,
    newMfaTicketId,
    type MfaAttemptId,
    type MfaBinding,
    type MfaBindValue,
    type MfaCompletionId,
    type MfaReservationId,
    type MfaTicketId,
} from '#app/domain/secrets.js'
import type { LoginOrigin, LoginPlan } from '#vendor/types/types.js'
import logger from '#vendor/utils/logger.js'
import { sanitizeRedisKey } from '#vendor/utils/session/redis-session-storage.js'

// feat-245 (docs/plan/passkeys-mfa-plan.md, Р4): the one-time ticket between the first factor and
// the second. It lives in Redis under the hash of a random id that only the browser holds (an
// HttpOnly cookie), and is bound to that browser by a second cookie (feat-257: `mfa_bind`, a
// random value of its own, which outlives a replaced or deleted session).
//
// States: `open` (attempts may run) → `completing` (one attempt won; the plan of the session and
// the transaction id are stored) → `activated` (the session exists) → deleted. A known rollback
// takes `completing` back to `open`.
//
// The attempt limit counts proofs found wrong (`failures`), not requests: an attempt holds a
// reservation while it runs, and an attempt that never got its proof checked gives it back. A
// reservation older than the reservation TTL is abandoned (a process that stopped) and dropped.
// Every reservation is accounted once (`settled`).
//
// feat-256 (docs/plan/mfa-review-fixes-7-plan.md, items 1 and 6): a failure is counted once per
// logical attempt (`attemptId`, kept by the browser for a repeat of the same request only), in
// `failedAttempts`, so a repeat after a lost answer neither counts twice nor escapes the count.
// Only an `open` ticket is deleted at the limit: a late failure never removes a ticket an attempt
// captured; a confirmed rollback deletes it once it is back to `open` at the limit.

export const MFA_MAX_FAILURES = 5

export interface PendingOAuthLink {
    /** What proved the address when the link was decided (the audit proof of `auth.oauth.linked`). */
    proof: 'oauth_provider_email' | 'oauth_email_link'
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
    binding: MfaBinding
    origin: Exclude<LoginOrigin, { inherit: unknown }>
    /** The first factor, as an `amr` of the session. */
    firstFactor: 'pwd' | 'oauth'
    redirect?: string | null
    pendingOAuthLink?: PendingOAuthLink | null
    failures: number
    reservations: { id: string; at: number; attempt?: string }[]
    settled: string[]
    /** feat-256: the logical attempts whose wrong proof is counted in `failures`. */
    failedAttempts?: string[]
    completionId?: string
    xid?: string
    plan?: LoginPlan
    sessionId?: string
    /** Set by the activation: the sign-in's effects wait for their one claim (session-index). */
    effects?: 'pending' | 'done'
}

/** The Redis key of a ticket: the hash of its id, so a leaked key opens nothing. */
export const mfaTicketKey = (ticketId: MfaTicketId): string =>
    `auth:mfa:${createHash('sha256').update(ticketId).digest('base64url')}`

export const newTicketId = (): MfaTicketId => newMfaTicketId()

/**
 * The browser binding (Р4): a keyed hash of the value of the ticket's binding cookie (feat-257,
 * `mfa_bind`; before it, the session id, which a replaced session took away).
 */
export const mfaBinding = (bindValue: MfaBindValue): MfaBinding =>
    mfaBindingOf(appConfig.key ?? '', bindValue)

/** feat-257: a new value of the binding cookie, one per ticket. */
export const newBindValue = (): MfaBindValue => newMfaBindValue()

// Lua: cjson turns an empty array into an empty object; the TS side normalizes both.
const LUA_COMMON = `
local function load(key)
  local raw = redis.call('GET', key)
  if not raw then return nil end
  local ok, ticket = pcall(cjson.decode, raw)
  if not ok or type(ticket) ~= 'table' then return nil end
  if type(ticket.reservations) ~= 'table' then ticket.reservations = {} end
  if type(ticket.settled) ~= 'table' then ticket.settled = {} end
  if type(ticket.failedAttempts) ~= 'table' then ticket.failedAttempts = {} end
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
local function hasFailed(ticket, attempt)
  for _, a in ipairs(ticket.failedAttempts) do
    if a == attempt then return true end
  end
  return false
end
-- The passkey challenge an attempt checked: still the ticket's current one. A code checked no
-- challenge (has = '0'): nothing to check, and KEYS[2] is a placeholder never touched.
local function challengeHolds(has, challengeKey, checked)
  if has ~= '1' then return true end
  return redis.call('GET', challengeKey) == checked
end
local function spendChallenge(has, challengeKey)
  if has == '1' then redis.call('DEL', challengeKey) end
end
`

/**
 * KEYS: ticket. ARGV: binding, now (ms), reservation TTL (ms), max failures, reservation id,
 * attempt id. Answers [outcome, ticket JSON]: `ok` (a reservation is held), `failed` (this logical
 * attempt's wrong proof is counted already: nothing is reserved), `busy` (failures + reservations
 * at the limit), `invalid` (no ticket, or another browser), or the state when it is not `open`.
 * A live reservation of the same attempt (a repeat whose first request is still running or lost)
 * is replaced: one place per logical attempt.
 */
const RESERVE_LUA = `${LUA_COMMON}
local ticket = load(KEYS[1])
if not ticket or ticket.binding ~= ARGV[1] then return {'invalid', ''} end
if ticket.state ~= 'open' then return {ticket.state, cjson.encode(ticket)} end
if hasFailed(ticket, ARGV[6]) then return {'failed', ''} end
local now = tonumber(ARGV[2])
live(ticket, now, tonumber(ARGV[3]))
local kept = {}
for _, r in ipairs(ticket.reservations) do
  if r.attempt ~= ARGV[6] then table.insert(kept, r) end
end
ticket.reservations = kept
if ticket.failures + #ticket.reservations >= tonumber(ARGV[4]) then
  save(KEYS[1], ticket)
  return {'busy', cjson.encode(ticket)}
end
table.insert(ticket.reservations, { id = ARGV[5], at = now, attempt = ARGV[6] })
save(KEYS[1], ticket)
return {'ok', cjson.encode(ticket)}
`

/**
 * KEYS: ticket, passkey challenge (the ticket again for a code). ARGV: reservation id, outcome
 * (`failure` | `release`), max failures, attempt id, the challenge the attempt checked, `1` when
 * it checked one. A failure counts even
 * when its reservation expired meanwhile, once per logical attempt; a release gives the place
 * back. Accounted once per reservation. A passkey failure counts only while the ticket's challenge
 * is still the one checked, and spends it in the same step; otherwise `stale` (a release: nothing
 * counted). Only an `open` ticket is deleted at the limit (`deleted`); a captured one stays for its
 * activation, and a confirmed rollback deletes it (REOPEN_LUA).
 */
const SETTLE_LUA = `${LUA_COMMON}
local ticket = load(KEYS[1])
if not ticket then return 'gone' end
if wasSettled(ticket, ARGV[1]) then return 'settled' end
settle(ticket, ARGV[1])
if ARGV[2] == 'failure' then
  if hasFailed(ticket, ARGV[4]) then
    save(KEYS[1], ticket)
    return 'ok'
  end
  if not challengeHolds(ARGV[6], KEYS[2], ARGV[5]) then
    save(KEYS[1], ticket)
    return 'stale'
  end
  spendChallenge(ARGV[6], KEYS[2])
  table.insert(ticket.failedAttempts, ARGV[4])
  ticket.failures = ticket.failures + 1
  if ticket.state == 'open' and ticket.failures >= tonumber(ARGV[3]) then
    redis.call('DEL', KEYS[1])
    return 'deleted'
  end
end
save(KEYS[1], ticket)
return 'ok'
`

/**
 * KEYS: ticket, passkey challenge (the ticket again for a code). ARGV: reservation id, now (ms),
 * reservation TTL (ms), completion id, xid, plan JSON, the challenge the attempt checked, `1`
 * when it checked one. The attempt wins only
 * while the ticket is `open`, its reservation is live and (a passkey) the ticket's challenge is
 * still the one checked, which the capture spends: `ok`, `used` (another attempt won), `expired`
 * (the reservation lapsed), `stale` (the challenge was spent or replaced) or `gone`.
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
if not challengeHolds(ARGV[8], KEYS[2], ARGV[7]) then
  save(KEYS[1], ticket)
  return 'stale'
end
spendChallenge(ARGV[8], KEYS[2])
settle(ticket, ARGV[1])
ticket.state = 'completing'
ticket.completionId = ARGV[4]
ticket.xid = ARGV[5]
ticket.plan = cjson.decode(ARGV[6])
save(KEYS[1], ticket)
return 'ok'
`

/**
 * KEYS: ticket. ARGV: completion id, max failures. A known rollback: `completing` back to `open`
 * (`reopened`); a ticket that late failures brought to the limit meanwhile is deleted instead
 * (`deleted`); `no` when it is not this completion's.
 */
const REOPEN_LUA = `${LUA_COMMON}
local ticket = load(KEYS[1])
if not ticket or ticket.state ~= 'completing' or ticket.completionId ~= ARGV[1] then return 'no' end
if ticket.failures >= tonumber(ARGV[2]) then
  redis.call('DEL', KEYS[1])
  return 'deleted'
end
ticket.state = 'open'
ticket.completionId = nil
ticket.xid = nil
ticket.plan = nil
save(KEYS[1], ticket)
return 'reopened'
`

/**
 * KEYS: ticket. ARGV: binding. Deletes the ticket only while it is `open` and this browser's:
 * `deleted`; `absent` when there is none (or another browser's); otherwise its state, and it stays
 * (an attempt captured it between a read and a delete).
 */
const DELETE_IF_OPEN_LUA = `${LUA_COMMON}
local ticket = load(KEYS[1])
if not ticket or ticket.binding ~= ARGV[1] then return 'absent' end
if ticket.state ~= 'open' then return ticket.state end
redis.call('DEL', KEYS[1])
return 'deleted'
`

/**
 * KEYS: ticket. ARGV: completion id. Deletes the ticket once its session is in use: `retired`;
 * `absent` when there is no ticket (or it cannot be read); `foreign` when the ticket belongs to
 * another completion (a newer second step of this browser), which is left as it is.
 */
const RETIRE_LUA = `${LUA_COMMON}
if redis.call('EXISTS', KEYS[1]) == 0 then return 'absent' end
local ticket = load(KEYS[1])
if not ticket then return 'absent' end
if ticket.completionId ~= ARGV[1] then return 'foreign' end
redis.call('DEL', KEYS[1])
return 'retired'
`

const asArray = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : [])

const parseTicket = (raw: string): MfaTicket | null => {
    try {
        const ticket = JSON.parse(raw) as MfaTicket
        return {
            ...ticket,
            reservations: asArray(ticket.reservations),
            settled: asArray(ticket.settled),
            failedAttempts: asArray(ticket.failedAttempts),
        }
    } catch (err) {
        // A ticket that does not parse is treated as gone (the sign-in starts again); the raw
        // value stays out of the log, it carries the session plan.
        logger.warn({ err }, 'MFA ticket JSON corrupt; treated as gone')
        return null
    }
}

const key = (ticketId: MfaTicketId): string => sanitizeRedisKey(mfaTicketKey(ticketId))

export type ReserveOutcome =
    | { kind: 'ok'; ticket: MfaTicket }
    | { kind: 'failed' }
    | { kind: 'busy' }
    | { kind: 'invalid' }
    | { kind: 'completing' | 'activated'; ticket: MfaTicket }

/** What retiring a ticket found (RETIRE_LUA). */
export type RetireOutcome = 'retired' | 'absent' | 'foreign'

/** What a known rollback did to the ticket (REOPEN_LUA). */
export type ReopenOutcome = 'reopened' | 'deleted' | 'no'

/**
 * feat-256: the passkey challenge an attempt checked (its Redis key and value), spent by the
 * failure count or the capture only while it is still the ticket's current one.
 */
export interface CheckedChallenge {
    key: string
    value: string
}

export type SettleOutcome = 'ok' | 'deleted' | 'settled' | 'gone' | 'stale'

export const mfaTicketStore = {
    async create(ticketId: MfaTicketId, ticket: MfaTicket, ttlSeconds: Seconds): Promise<void> {
        await withRedis(() =>
            setWithTtlSeconds(redis, key(ticketId), JSON.stringify(ticket), ttlSeconds),
        )
    },

    async read(ticketId: MfaTicketId): Promise<MfaTicket | null> {
        const raw = await withRedis(() => redis.get(key(ticketId)))
        return raw === null ? null : parseTicket(raw)
    },

    /** Remaining lifetime in seconds (0 when gone). */
    async ttl(ticketId: MfaTicketId): Promise<Seconds> {
        const left = await withRedis(() => redis.ttl(key(ticketId)))
        return seconds(left > 0 ? left : 0)
    },

    async reserve(
        ticketId: MfaTicketId,
        binding: MfaBinding,
        reservationId: MfaReservationId,
        now: UnixMs,
        reservationTtlMs: Milliseconds,
        /** The logical attempt; a repeat of the same request carries the same one. */
        attemptId: MfaAttemptId = mfaAttemptIdOf(reservationId),
    ): Promise<ReserveOutcome> {
        const [outcome, json] = (await withRedis(() =>
            redis.eval(
                RESERVE_LUA,
                1,
                key(ticketId),
                binding,
                String(now),
                msArg(reservationTtlMs),
                String(MFA_MAX_FAILURES),
                reservationId,
                attemptId,
            ),
        )) as [string, string]
        if (outcome === 'busy') return { kind: 'busy' }
        if (outcome === 'failed') return { kind: 'failed' }
        if (outcome === 'invalid') return { kind: 'invalid' }
        const ticket = parseTicket(json)
        if (ticket === null) return { kind: 'invalid' }
        if (outcome === 'completing' || outcome === 'activated') return { kind: outcome, ticket }
        if (outcome === 'ok') return { kind: 'ok', ticket }
        return { kind: 'invalid' }
    },

    async settle(
        ticketId: MfaTicketId,
        reservationId: MfaReservationId,
        outcome: 'failure' | 'release',
        options: { attemptId?: MfaAttemptId; challenge?: CheckedChallenge | null } = {},
    ): Promise<SettleOutcome> {
        const challenge = options.challenge ?? null
        return (await withRedis(() =>
            redis.eval(
                SETTLE_LUA,
                2,
                key(ticketId),
                challenge?.key ?? key(ticketId),
                reservationId,
                outcome,
                String(MFA_MAX_FAILURES),
                options.attemptId ?? reservationId,
                challenge?.value ?? '',
                challenge === null ? '0' : '1',
            ),
        )) as SettleOutcome
    },

    async capture(
        ticketId: MfaTicketId,
        reservationId: MfaReservationId,
        now: UnixMs,
        reservationTtlMs: Milliseconds,
        completion: { completionId: MfaCompletionId; xid: string; plan: LoginPlan },
        challenge: CheckedChallenge | null = null,
    ): Promise<'ok' | 'used' | 'expired' | 'stale' | 'gone'> {
        return (await withRedis(() =>
            redis.eval(
                CAPTURE_LUA,
                2,
                key(ticketId),
                challenge?.key ?? key(ticketId),
                reservationId,
                String(now),
                msArg(reservationTtlMs),
                completion.completionId,
                completion.xid,
                JSON.stringify(completion.plan),
                challenge?.value ?? '',
                challenge === null ? '0' : '1',
            ),
        )) as 'ok' | 'used' | 'expired' | 'stale' | 'gone'
    },

    async reopen(ticketId: MfaTicketId, completionId: MfaCompletionId): Promise<ReopenOutcome> {
        const outcome = await withRedis(() =>
            redis.eval(REOPEN_LUA, 1, key(ticketId), completionId, String(MFA_MAX_FAILURES)),
        )
        return outcome === 'reopened' || outcome === 'deleted' ? outcome : 'no'
    },

    /** Deletes the ticket only while it is `open` and this browser's (DELETE_IF_OPEN_LUA). */
    async deleteIfOpen(
        ticketId: MfaTicketId,
        binding: MfaBinding,
    ): Promise<'deleted' | 'absent' | 'completing' | 'activated'> {
        const outcome = await withRedis(() =>
            redis.eval(DELETE_IF_OPEN_LUA, 1, key(ticketId), binding),
        )
        return outcome === 'completing' || outcome === 'activated' || outcome === 'deleted'
            ? outcome
            : 'absent'
    },

    async retire(ticketId: MfaTicketId, completionId: MfaCompletionId): Promise<RetireOutcome> {
        const outcome = await withRedis(() =>
            redis.eval(RETIRE_LUA, 1, key(ticketId), completionId),
        )
        if (outcome === 'retired' || outcome === 'foreign') return outcome
        return 'absent'
    },

    async delete(ticketId: MfaTicketId): Promise<void> {
        await withRedis(() => redis.del(key(ticketId)))
    },

    /** The key the activation transition reads (sanitized by the session store itself). */
    keyOf: mfaTicketKey,
}
