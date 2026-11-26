import type { Checkpoint } from '#app/services/shared/checkpoint.js'
import { ms } from 'shared/brand'
import {
    acquireLease,
    DATABASE_WRITE_BOUND_MS,
    leaseForDatabaseWrites,
    type HeldLease,
    type Lease,
} from '#app/services/shared/redis-lease.js'
import logger from '#logger'

// feat-222 (scheduler plan Р9, Р13): the one way to a job's lease. The scheduled run, a manual
// `job:run` and the old purge CLI all go through withJobLease, so they exclude each other and get
// the same checkpoint.

export const JOB_LEASE_TTL_MS = ms(15_000)
export const JOB_LEASE_RENEW_EVERY_MS = ms(5_000)
/** Time after the job's timeout for the write in flight, the end of run(), the state write and the release. */
export const JOB_FINALIZE_MARGIN_MS = 10_000

/**
 * Р13: the lease of a job with this timeout. Its maximum lifetime lies past the timeout plus the
 * longest write, so a job that runs into its timeout ends with `timeout`, not `lease-lost`.
 */
export const leaseForJob = (timeoutMs: number): Lease =>
    leaseForDatabaseWrites({
        ttlMs: JOB_LEASE_TTL_MS,
        renewEveryMs: JOB_LEASE_RENEW_EVERY_MS,
        maxLifetimeMs: timeoutMs + DATABASE_WRITE_BOUND_MS + JOB_FINALIZE_MARGIN_MS,
    })

export const jobLeaseKey = (name: string): string => `sched:lease:${name}`

export class JobLeaseLostError extends Error {
    override readonly name = 'JobLeaseLostError'

    constructor(reason: string) {
        super(`The job lease was lost: ${reason}`)
    }
}

export class JobTimeoutError extends Error {
    override readonly name = 'JobTimeoutError'

    constructor(timeoutMs: number) {
        super(`The job ran past its timeout of ${String(timeoutMs)} ms`)
    }
}

export interface JobLeaseScope {
    lease: HeldLease
    /** Lease lost, timeout or the caller's signal. */
    signal: AbortSignal
    /** signal.throwIfAborted() + lease.checkpoint(). */
    checkpoint: Checkpoint
}

export type JobLeaseResult<T> =
    { status: 'busy' } | { status: 'done'; value: T; signal: AbortSignal }

export interface JobLeaseOptions {
    name: string
    timeoutMs: number
    /** The caller's stop: the scheduler's shutdown, SIGINT in a CLI. */
    signal?: AbortSignal | undefined
}

export type WithJobLease = <T>(
    options: JobLeaseOptions,
    fn: (scope: JobLeaseScope) => Promise<T>,
) => Promise<JobLeaseResult<T>>

/**
 * Takes `sched:lease:<name>`, runs `fn` under it and releases it. Busy → `{ status: 'busy' }`
 * without calling `fn`. An error of `fn` is rethrown after the release; a failed release is
 * logged and does not replace the result. A Redis outage while taking the lease is thrown.
 * After `scope.lease.abandon()` (a shutdown that could not wait) the release is a no-op and the
 * key lives to its TTL.
 */
export const withJobLease: WithJobLease = async (options, fn) => {
    const { name, timeoutMs, signal: callerSignal } = options
    const lease = await acquireLease(
        jobLeaseKey(name),
        leaseForJob(timeoutMs),
        (reason) => new JobLeaseLostError(reason),
    )
    if (lease === null) return { status: 'busy' }

    // Not AbortSignal.timeout: its reason is a bare DOMException, and its timer cannot be
    // cleared once the run is over.
    const timeout = new AbortController()
    const timer = setTimeout(() => {
        timeout.abort(new JobTimeoutError(timeoutMs))
    }, timeoutMs)
    timer.unref()
    const signal = AbortSignal.any([
        lease.lost,
        timeout.signal,
        ...(callerSignal === undefined ? [] : [callerSignal]),
    ])
    const checkpoint: Checkpoint = () => {
        signal.throwIfAborted()
        lease.checkpoint()
    }

    try {
        const value = await fn({ lease, signal, checkpoint })
        return { status: 'done', value, signal }
    } finally {
        clearTimeout(timer)
        try {
            await lease.release()
        } catch (err: unknown) {
            logger.warn({ err, job: name }, 'Scheduler: the job lease could not be released')
        }
    }
}
