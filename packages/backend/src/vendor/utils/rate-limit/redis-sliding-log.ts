import { randomUUID } from 'node:crypto'
import type { Redis } from 'ioredis'
import { ms, type Milliseconds } from 'shared/brand'
import { msArg } from '#vendor/utils/redis/redis-ttl.js'
import type { RateLimitDecision } from './rate-limit-store.js'

// Sliding log on a ZSET with the semantics of the in-memory store: rejected
// attempts are not stored and retryAfterMs is the moment a slot frees up.
// Time comes from Redis (TIME), so instance clock skew does not matter. The
// member carries a per-request nonce: ZADD on an existing member only updates
// its score, so two requests in the same microsecond would otherwise collapse.
const SLIDING_LOG_LUA = `
local window = tonumber(ARGV[1])
local max = tonumber(ARGV[2])
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + tonumber(t[2]) / 1000
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - window)
local count = redis.call('ZCARD', KEYS[1])
if count < max then
  redis.call('ZADD', KEYS[1], now, t[1] .. t[2] .. '-' .. ARGV[3])
  redis.call('PEXPIRE', KEYS[1], window)
  local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  return {1, max - count - 1, math.ceil(tonumber(oldest[2]) + window)}
end
local blocking = redis.call('ZRANGE', KEYS[1], count - max, count - max, 'WITHSCORES')
local resetAt = tonumber(blocking[2]) + window
return {0, math.ceil(resetAt - now), math.ceil(resetAt)}
`

export interface SlidingLogOptions {
    /** feat-272 (Р7): the window, as the script's PEXPIRE and its scores take it. */
    windowMs: Milliseconds
    max: number
}

export const slidingLogKey = (scope: string, id: string): string => `rl:${scope}:${id}`

export async function consumeRedisSlidingLog(
    client: Pick<Redis, 'eval'>,
    key: string,
    { windowMs, max }: SlidingLogOptions,
    nonce: string = randomUUID(),
): Promise<RateLimitDecision> {
    const reply = (await client.eval(
        SLIDING_LOG_LUA,
        1,
        key,
        msArg(windowMs),
        String(max),
        nonce,
    )) as [number, number, number]
    const [allowed, value, resetAt] = reply
    return allowed === 1
        ? { allowed: true, limit: max, remaining: value, resetAt }
        : { allowed: false, limit: max, retryAfterMs: ms(value), resetAt }
}
