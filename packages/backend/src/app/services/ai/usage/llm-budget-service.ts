import redis from '#database/redis-rate-limit.js'
import logger from '#logger'

// The daily token budget of a user (ADR 0003). Enforcement lives in Redis only: the usage
// log (`llm_text_usage`) is an audit written after the fact and cannot be asked "may this
// run start?".
//
// A run RESERVES an estimate of what it may cost, in one atomic check-and-add, before the
// first paid call. At the end it SETTLES: the counter is brought to what was really spent.
// The rules of the settlement are what keep a cancelled request from being free:
//   - a call that was never started costs nothing (its share is given back);
//   - a started call costs what the provider reported;
//   - a started call without a report (cut off, timed out, failed) costs its estimate.

const DAY_KEY_TTL_MS = 48 * 3_600_000

// KEYS[1] counter; ARGV: reserve, limit, ttl. -1: it does not fit and nothing was added.
const RESERVE_LUA = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
if current + tonumber(ARGV[1]) > tonumber(ARGV[2]) then
  return -1
end
local value = redis.call('INCRBY', KEYS[1], ARGV[1])
if redis.call('PTTL', KEYS[1]) < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[3])
end
return value
`

// KEYS[1] counter; ARGV: delta (may be negative), ttl. Never below zero; a counter that had
// expired meanwhile gets a TTL again rather than living for ever.
const SETTLE_LUA = `
local value = redis.call('INCRBY', KEYS[1], ARGV[1])
if value < 0 then
  value = 0
  redis.call('SET', KEYS[1], 0, 'KEEPTTL')
end
if redis.call('PTTL', KEYS[1]) < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return value
`

export interface TokenReservation {
    /** What was added to the counter (the estimate, never above the limit). */
    readonly reserved: number
    /** Call right before the paid call is sent: from now on it is not free. */
    begin(kind: string): void
    /** The tokens the provider reported for the call; null when it did not report. */
    record(kind: string, totalTokens: number | null): void
    /**
     * Brings the counter to what was spent. Never throws: a failure is logged and the
     * reserve stays, which errs on the side of charging; calling again retries it.
     */
    settle(): Promise<void>
}

export type ReserveResult =
    { allowed: true; reservation: TokenReservation } | { allowed: false; retryAfterSeconds: number }

const dayOf = (now: Date): string => now.toISOString().slice(0, 10)

const secondsToUtcMidnight = (now: Date): number => {
    const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)
    return Math.max(1, Math.ceil((next - now.getTime()) / 1000))
}

const counterKey = (userId: bigint, day: string): string => `llm:budget:${String(userId)}:${day}`

function sum(parts: Record<string, number>): number {
    return Object.values(parts).reduce((total, tokens) => total + tokens, 0)
}

function reservationOf(
    key: string | null,
    parts: Record<string, number>,
    reserved: number,
): TokenReservation {
    const started = new Set<string>()
    const reported = new Map<string, number | null>()
    let settled = false

    // What the run really cost, by the rules at the top of this file.
    const spent = (): number => {
        let total = 0
        for (const [kind, estimate] of Object.entries(parts)) {
            if (!started.has(kind)) continue
            const tokens = reported.get(kind)
            total += tokens ?? estimate
        }
        return total
    }

    return {
        reserved,
        begin: (kind): void => {
            started.add(kind)
        },
        record: (kind, totalTokens): void => {
            reported.set(kind, totalTokens)
        },
        settle: async (): Promise<void> => {
            if (settled || key === null) return
            const delta = spent() - reserved
            try {
                if (delta !== 0) {
                    await redis.eval(SETTLE_LUA, 1, key, String(delta), String(DAY_KEY_TTL_MS))
                }
                settled = true
            } catch (err) {
                logger.warn({ err, key }, 'LLM budget: could not settle, the reserve stays')
            }
        },
    }
}

/**
 * Reserves the estimate (`parts`: tokens per call) against the user's budget for today (UTC).
 * Rejects when Redis does not answer: the caller refuses the message (fail closed).
 * `limit` 0 switches the budget off (development only; production refuses it at startup).
 */
export async function reserveDailyTokens(
    userId: bigint,
    parts: Record<string, number>,
    options: { limit: number; now?: Date },
): Promise<ReserveResult> {
    const now = options.now ?? new Date()
    const estimate = sum(parts)
    if (options.limit === 0 || estimate === 0) {
        return { allowed: true, reservation: reservationOf(null, parts, 0) }
    }

    // Asking for more than the limit would make every message refuse for ever.
    const reserved = Math.min(estimate, options.limit)
    const key = counterKey(userId, dayOf(now))
    const value = Number(
        await redis.eval(
            RESERVE_LUA,
            1,
            key,
            String(reserved),
            String(options.limit),
            String(DAY_KEY_TTL_MS),
        ),
    )
    if (value < 0) return { allowed: false, retryAfterSeconds: secondsToUtcMidnight(now) }

    return { allowed: true, reservation: reservationOf(key, parts, reserved) }
}
