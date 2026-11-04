import { acquireLease, type HeldLease, type Lease } from '#app/services/shared/redis-lease.js'

// One support answer at a time per user. Every answer is several language-model calls,
// so a second message (or a greeting) while the first is being written is refused.
//
// The lock is a lease with an owner (redis-lease.ts): the pipeline waits on the database without
// a bound of its own, so the live answer keeps renewing it, and must start no further paid step
// once `lost` aborts.

export type SupportLease = Lease
export type SupportInflightLock = HeldLease

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
export function acquireSupportLock(
    userId: bigint,
    lease: SupportLease,
): Promise<SupportInflightLock | null> {
    return acquireLease(lockKey(userId), lease, (reason) => new SupportLockLostError(reason))
}
