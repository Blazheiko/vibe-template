import { nanoid } from 'nanoid'

import redis, { withRedis } from '#database/redis.js'

// One support answer at a time per user. Every answer is several language-model calls,
// so a second message (or a greeting) while the first is being written is refused.
//
// The lock is a lease with an owner.
//
// - Owner: a plain DEL in a `finally` would be wrong, a request that outlived the lock would
//   delete the lock that a newer request took over. Renewal and release both act only if the
//   key still holds this request's token (one Lua script each, so check and act cannot be
//   separated).
// - Lease: the pipeline waits on the database without a bound of its own, so no fixed TTL
//   is long enough. The key gets a short TTL that the holder renews while it lives. If the
//   renewals stop working (Redis silent, the key taken over, the maximum lifetime reached)
//   the holder is told through `lost` BEFORE the key can expire, and must start no further
//   paid step. A dead process stops renewing and the key expires within one TTL.

const RELEASE_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`

const RENEW_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`

export interface SupportLease {
    /** How long the key lives without a renewal. */
    ttlMs: number
    /** How often the holder renews; well under `ttlMs`, so one failed renewal is survivable. */
    renewEveryMs: number
    /** After this the lease is abandoned (told lost, no more renewals): a stuck run must not hold the user for ever. */
    maxLifetimeMs: number
}

export interface SupportInflightLock {
    /** Aborts when the lease can no longer be trusted: the holder must stop. */
    readonly lost: AbortSignal
    /** True when this request still owned the lock and released it. Stops the renewals. */
    release(): Promise<boolean>
}

const lockKey = (userId: bigint): string => `support:inflight:${String(userId)}`

export class SupportLockLostError extends Error {
    override readonly name = 'SupportLockLostError'

    constructor(reason: string) {
        super(`The support lock was lost: ${reason}`)
    }
}

/**
 * Takes the user's lock, or returns null when someone holds it. The returned lock renews
 * itself until it is released, lost or past its maximum lifetime.
 */
export async function acquireSupportLock(
    userId: bigint,
    lease: SupportLease,
): Promise<SupportInflightLock | null> {
    const key = lockKey(userId)
    const token = nanoid()
    const startedAt = Date.now()
    const reply = await withRedis(() => redis.set(key, token, 'PX', lease.ttlMs, 'NX'))
    if (reply !== 'OK') return null

    const lostController = new AbortController()
    // The last moment the key is known to have been extended: measured from the start of the
    // renewal call, because the server applies it at some point after that.
    let extendedAt = startedAt
    let renewing = false

    const markLost = (reason: string): void => {
        clearInterval(timer)
        if (!lostController.signal.aborted) lostController.abort(new SupportLockLostError(reason))
    }

    const renew = async (): Promise<void> => {
        renewing = true
        const sentAt = Date.now()
        try {
            const renewed = await withRedis(() =>
                redis.eval(RENEW_LUA, 1, key, token, String(lease.ttlMs)),
            )
            if (renewed === 1) extendedAt = sentAt
            else markLost('the key is gone or belongs to another request')
        } catch {
            // Redis did not answer: tried again on the next tick; the deadline check decides.
        } finally {
            renewing = false
        }
    }

    const timer = setInterval(() => {
        const now = Date.now()
        if (now - startedAt >= lease.maxLifetimeMs) {
            markLost('the maximum lifetime was reached')
            return
        }
        // Declared lost one renewal interval before the key could expire, so the holder has
        // stopped before anyone else can take the lock.
        if (now - extendedAt >= lease.ttlMs - lease.renewEveryMs) {
            markLost('it could not be renewed')
            return
        }
        if (!renewing) void renew()
    }, lease.renewEveryMs)
    timer.unref()

    return {
        lost: lostController.signal,
        release: async (): Promise<boolean> => {
            clearInterval(timer)
            return (await withRedis(() => redis.eval(RELEASE_LUA, 1, key, token))) === 1
        },
    }
}
