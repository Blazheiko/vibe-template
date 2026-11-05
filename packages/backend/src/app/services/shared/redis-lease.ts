import { nanoid } from 'nanoid'

import redis, { withRedis } from '#database/redis.js'

// A Redis lock that is a lease with an owner (first used by the support in-flight lock, feat-115
// shares it with the knowledge-base init).
//
// - Owner: a plain DEL in a `finally` would be wrong, a holder that outlived the lock would
//   delete the lock that a newer holder took over. Renewal and release both act only if the
//   key still holds this holder's token (one Lua script each, so check and act cannot be
//   separated).
// - Lease: the holder's work has no bound of its own, so no fixed TTL is long enough. The key
//   gets a short TTL that the holder renews while it lives. If the renewals stop working (Redis
//   silent, the key taken over, the maximum lifetime reached) the holder is told through `lost`
//   BEFORE the key can expire, and must start no further step. A dead process stops renewing and
//   the key expires within one TTL.

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

export interface Lease {
    /** How long the key lives without a renewal. */
    ttlMs: number
    /** How often the holder renews; well under `ttlMs`, so one failed renewal is survivable. */
    renewEveryMs: number
    /** After this the lease is abandoned (told lost, no more renewals): a stuck run must not hold the lock for ever. */
    maxLifetimeMs: number
}

export interface HeldLease {
    /** Aborts when the lease can no longer be trusted: the holder must stop. */
    readonly lost: AbortSignal
    /** True when this holder still owned the lock and released it. Stops the renewals. */
    release(): Promise<boolean>
}

/**
 * Takes the lock at `key`, or returns null when someone holds it. The returned lease renews
 * itself until it is released, lost or past its maximum lifetime; `lostError` is the abort reason
 * of `lost`.
 */
export async function acquireLease(
    key: string,
    lease: Lease,
    lostError: (reason: string) => Error,
): Promise<HeldLease | null> {
    const token = nanoid()
    // feat-122 (L6): a monotonic clock; a wall-clock step must not stretch or shorten the lease.
    const now = (): number => performance.now()
    const startedAt = now()
    const reply = await withRedis(() => redis.set(key, token, 'PX', lease.ttlMs, 'NX'))
    if (reply !== 'OK') return null

    const lostController = new AbortController()
    let renewing = false
    let deadline: ReturnType<typeof setTimeout> | undefined

    const stopTimers = (): void => {
        clearInterval(timer)
        clearTimeout(deadline)
        clearTimeout(lifetime)
    }

    const markLost = (reason: string): void => {
        stopTimers()
        if (!lostController.signal.aborted) lostController.abort(lostError(reason))
    }

    // feat-122 (L6): the lease is lost one renewal interval before the key can expire, on a timer
    // of its own. A check on the renewal tick alone could land just short of that moment and the
    // next one only when the key was already gone. The key was extended at some point after
    // `extendedAt` (the start of the call that extended it), so it lives at least until
    // extendedAt + ttlMs.
    const armDeadline = (extendedAt: number): void => {
        clearTimeout(deadline)
        const lostAt = extendedAt + lease.ttlMs - lease.renewEveryMs
        deadline = setTimeout(
            () => {
                markLost('it could not be renewed')
            },
            Math.max(0, lostAt - now()),
        )
        deadline.unref()
    }

    const renew = async (): Promise<void> => {
        renewing = true
        const sentAt = now()
        try {
            const renewed = await withRedis(() =>
                redis.eval(RENEW_LUA, 1, key, token, String(lease.ttlMs)),
            )
            if (lostController.signal.aborted) return
            if (renewed === 1) armDeadline(sentAt)
            else markLost('the key is gone or belongs to another holder')
        } catch {
            // Redis did not answer: tried again on the next tick; the deadline decides.
        } finally {
            renewing = false
        }
    }

    const timer = setInterval(() => {
        if (!renewing) void renew()
    }, lease.renewEveryMs)
    timer.unref()
    const lifetime = setTimeout(() => {
        markLost('the maximum lifetime was reached')
    }, lease.maxLifetimeMs)
    lifetime.unref()
    armDeadline(startedAt)

    return {
        lost: lostController.signal,
        release: async (): Promise<boolean> => {
            stopTimers()
            return (await withRedis(() => redis.eval(RELEASE_LUA, 1, key, token))) === 1
        },
    }
}
