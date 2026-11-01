import { nanoid } from 'nanoid'

import redis, { withRedis } from '#database/redis.js'

// One support answer at a time per user. Every answer is several language-model calls,
// so a second message (or a greeting) while the first is being written is refused.
//
// The lock has an owner. A plain DEL in a `finally` would be wrong: a request that outlived
// the lock's TTL would delete the lock that a newer request took over, and two answers
// would run at once. The release deletes the key only if it still holds this request's
// token (one Lua script, so the check and the delete cannot be separated).

const RELEASE_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`

export interface SupportInflightLock {
    /** True when this request still owned the lock and released it. */
    release(): Promise<boolean>
}

const lockKey = (userId: bigint): string => `support:inflight:${String(userId)}`

/**
 * Takes the user's lock for `ttlMs`, or returns null when someone holds it. The TTL is the
 * longest the pipeline may take; it only matters when the process dies before releasing.
 */
export async function acquireSupportLock(
    userId: bigint,
    ttlMs: number,
): Promise<SupportInflightLock | null> {
    const key = lockKey(userId)
    const token = nanoid()
    const reply = await withRedis(() => redis.set(key, token, 'PX', ttlMs, 'NX'))
    if (reply !== 'OK') return null

    return {
        release: async (): Promise<boolean> =>
            (await withRedis(() => redis.eval(RELEASE_LUA, 1, key, token))) === 1,
    }
}
