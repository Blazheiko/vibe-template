import { setTimeout as sleepFor } from 'node:timers/promises'
import { unixMs } from 'shared/brand'

import { sentryService, type SentryContext } from '#app/services/observability/sentry-service.js'
import type { HeldLease } from '#app/services/shared/redis-lease.js'
import logger from '#logger'
import { isRedisUnavailable } from '#vendor/utils/network/errors/redis-unavailable-error.js'

import { categoryOf, type Job, type JobLogger, type JobResult, type Outcome } from './job.js'
import { JobLeaseLostError, JobTimeoutError, withJobLease, type WithJobLease } from './job-lease.js'
import { slotOf } from './schedule.js'
import {
    backoffDelay,
    maxBackoffOf,
    redisSchedulerState,
    type JobState,
    type SchedulerState,
} from './scheduler-state.js'

// feat-222 (scheduler plan Р3–Р8, Р10): one loop per process. Every tick (with ±20 % jitter) it
// walks the registry in order and runs at most one job at a time. A job runs under its lease
// (withJobLease) when its latest slot has not succeeded yet and its backoff is over; missed slots
// collapse into one run. The state (Р3) is read and written under the same lease.

export const DEFAULT_STOP_DRAIN_MS = 5_000

export class SchedulerStoppedError extends Error {
    override readonly name = 'SchedulerStoppedError'

    constructor() {
        super('The scheduler is stopping')
    }
}

export interface SchedulerLogger extends JobLogger {
    child?(bindings: object): JobLogger
}

export interface SchedulerDeps {
    jobs: readonly Job[]
    disabledJobs?: readonly string[]
    clock?: { now(): number }
    withLease?: WithJobLease
    state?: SchedulerState
    logger?: SchedulerLogger
    sentry?: { captureException(err: unknown, ctx?: SentryContext): void }
    /** SCHEDULER_TICK. */
    tickMs?: number
    /** How long stop() waits for the job in flight (default 5 s; not configurable by env, tests only). */
    stopDrainMs?: number
    random?: () => number
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

export interface RunOnceResult {
    outcome: Outcome
    matched: number
    changed: number
    error?: unknown
}

export interface Scheduler {
    start(): void
    /** Р10: no new runs, abort the one in flight, wait for it up to the drain, abandon the lease otherwise. */
    stop(): Promise<void>
    /** One pass over the registry; the loop calls it every tick. */
    tick(): Promise<void>
    /** A manual run (`job:run`): the same lease, no Р3 state read or written. */
    runOnce(
        name: string,
        options?: { dryRun?: boolean; signal?: AbortSignal },
    ): Promise<RunOnceResult>
}

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> =>
    sleepFor(ms, undefined, { signal, ref: false })

/** Why an aborted run stopped, from the reason of its signal. */
export const abortedOutcome = (reason: unknown): Outcome => {
    if (reason instanceof JobTimeoutError) return 'timeout'
    if (reason instanceof JobLeaseLostError) return 'lease-lost'
    return 'shutdown'
}

interface LocalRetry {
    nextRetryAt: number
    failures: number
    /** When this process recorded it: a success in Redis after this moment supersedes it. */
    since: number
}

interface RunRecord {
    job: string
    slot: number
    trigger: 'schedule' | 'manual'
    dryRun: boolean
    durationMs: number
    matched: number
    changed: number
    outcome: Outcome
    err?: unknown
    stateWritten?: boolean
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
    const jobs = deps.jobs
    const disabled = new Set(deps.disabledJobs ?? [])
    const clock = deps.clock ?? { now: (): number => Date.now() }
    const withLease = deps.withLease ?? withJobLease
    const state = deps.state ?? redisSchedulerState
    const log: SchedulerLogger = deps.logger ?? logger
    const sentry = deps.sentry ?? sentryService
    const tickMs = deps.tickMs ?? 30_000
    const stopDrainMs = deps.stopDrainMs ?? DEFAULT_STOP_DRAIN_MS
    const random = deps.random ?? Math.random
    const sleep = deps.sleep ?? defaultSleep

    const names = new Set<string>()
    for (const job of jobs) {
        if (names.has(job.name)) throw new Error(`Duplicate job name "${job.name}"`)
        names.add(job.name)
    }

    const stopController = new AbortController()
    const localRetry = new Map<string, LocalRetry>()
    let started = false
    let loop: Promise<void> | null = null
    let stopping: Promise<void> | null = null
    // The run in flight: what stop() waits for, and the lease it abandons.
    let inFlight: { done: Promise<unknown>; lease: HeldLease | null } | null = null

    const jobLogger = (name: string): JobLogger => log.child?.({ job: name }) ?? log

    const report = (record: RunRecord): void => {
        const { err, ...fields } = record
        const entry = {
            ...fields,
            slot: new Date(record.slot).toISOString(),
            category: categoryOf(record.outcome),
            ...(err === undefined ? {} : { err }),
        }
        const msg = `Scheduler: job ${record.job} ${record.outcome}`
        if (record.outcome === 'failed' || record.outcome === 'timeout') {
            // Sent to Sentry below with the job tag, not a second time through the logger.
            log.error({ ...entry, sentrySkip: true }, msg)
        } else if (record.outcome === 'lease-lost') {
            log.warn(entry, msg)
        } else {
            log.info(entry, msg)
        }
    }

    const reportToSentry = (outcome: Outcome, job: string, err: unknown): void => {
        if (outcome !== 'failed' && outcome !== 'timeout') return
        sentry.captureException(err ?? new Error(`Scheduled job ${job} ${outcome}`), {
            tags: { job, outcome },
        })
    }

    const holdLocally = (job: Job, failuresBefore: number): void => {
        const failures = Math.max(failuresBefore, localRetry.get(job.name)?.failures ?? 0) + 1
        const now = clock.now()
        localRetry.set(job.name, {
            failures,
            nextRetryAt: now + backoffDelay(failures, maxBackoffOf(job.schedule)),
            since: now,
        })
    }

    /**
     * The state in Redis is the reference: a success recorded there (by any replica) after this
     * process held the job back locally ends that local backoff and its failure count.
     */
    const reconcileLocal = (job: Job, current: JobState): void => {
        const local = localRetry.get(job.name)
        if (local === undefined) return
        if (
            current.lastOutcome === 'ok' &&
            current.lastRunAt !== undefined &&
            current.lastRunAt >= local.since
        ) {
            localRetry.delete(job.name)
        }
    }

    /** Runs the job under the scope's lease and tells how it ended. */
    const execute = async (
        job: Job,
        scope: { signal: AbortSignal; checkpoint: () => void },
        slot: number,
        dryRun: boolean,
    ): Promise<{ outcome: Outcome; result?: JobResult; err?: unknown; durationMs: number }> => {
        const startedAt = performance.now()
        let result: JobResult | undefined
        // feat-230: whether run() threw is its own flag; `err` can be undefined (`Promise.reject()`).
        let failed = false
        let err: unknown
        try {
            // A stop() or a lost lease while the lease was taken or the state read: no run.
            scope.checkpoint()
            result = await job.run({
                signal: scope.signal,
                checkpoint: scope.checkpoint,
                slot,
                dryRun,
                logger: jobLogger(job.name),
            })
        } catch (error: unknown) {
            failed = true
            err = error
        }
        const durationMs = Math.round(performance.now() - startedAt)
        // Р7: a run whose signal was aborted is never a success, even when run() returned.
        if (scope.signal.aborted) {
            return { outcome: abortedOutcome(scope.signal.reason), err, durationMs }
        }
        if (failed) return { outcome: 'failed', err, durationMs }
        return { outcome: 'ok', ...(result === undefined ? {} : { result }), durationMs }
    }

    const runScheduled = async (job: Job): Promise<void> => {
        const local = localRetry.get(job.name)
        if (local !== undefined && clock.now() < local.nextRetryAt) {
            report({
                job: job.name,
                slot: slotOf(job.schedule, clock.now()),
                trigger: 'schedule',
                dryRun: false,
                durationMs: 0,
                matched: 0,
                changed: 0,
                outcome: 'skipped-backoff',
            })
            return
        }

        const flight: { done: Promise<unknown>; lease: HeldLease | null } = {
            done: Promise.resolve(),
            lease: null,
        }
        const run = withLease(
            { name: job.name, timeoutMs: job.timeoutMs, signal: stopController.signal },
            async (scope) => {
                flight.lease = scope.lease
                // stop() came while the lease was being taken: no run.
                if (scope.signal.aborted) return
                const now = clock.now()
                const slot = slotOf(job.schedule, now)
                const current: JobState = await state.read(job.name)
                reconcileLocal(job, current)
                if (current.lastSuccessSlot !== undefined && current.lastSuccessSlot >= slot) {
                    // Not due: the slot already succeeded here or on another replica, so any
                    // local backoff is over too.
                    localRetry.delete(job.name)
                    return
                }
                if (current.nextRetryAt !== undefined && now < current.nextRetryAt) {
                    // Р3: the backoff is shared; keep it locally so the next ticks skip Redis.
                    localRetry.set(job.name, {
                        nextRetryAt: current.nextRetryAt,
                        failures: current.consecutiveFailures,
                        since: now,
                    })
                    report({
                        job: job.name,
                        slot,
                        trigger: 'schedule',
                        dryRun: false,
                        durationMs: 0,
                        matched: 0,
                        changed: 0,
                        outcome: 'skipped-backoff',
                    })
                    return
                }

                const ran = await execute(job, scope, slot, false)
                let outcome = ran.outcome
                let stateWritten: boolean | undefined
                const finishedAt = unixMs(clock.now())
                try {
                    if (outcome === 'ok') {
                        const write = await state.recordSuccess(scope.lease, job.name, {
                            slot,
                            durationMs: ran.durationMs,
                            now: finishedAt,
                        })
                        stateWritten = write.status === 'written'
                        if (write.status === 'written') localRetry.delete(job.name)
                        else {
                            outcome = 'lease-lost'
                            holdLocally(job, current.consecutiveFailures)
                        }
                    } else if (outcome === 'failed' || outcome === 'timeout') {
                        const write = await state.recordFailure(scope.lease, job.name, {
                            outcome,
                            durationMs: ran.durationMs,
                            now: finishedAt,
                            maxBackoffMs: maxBackoffOf(job.schedule),
                        })
                        stateWritten = write.status === 'written'
                        if (write.status === 'written') {
                            localRetry.set(job.name, {
                                nextRetryAt: write.nextRetryAt,
                                failures: current.consecutiveFailures + 1,
                                since: finishedAt,
                            })
                        } else {
                            reportToSentry(outcome, job.name, ran.err)
                            outcome = 'lease-lost'
                            holdLocally(job, current.consecutiveFailures)
                        }
                    } else if (outcome === 'lease-lost') {
                        // Р3: the state is not touched, but the job is held back locally: the key
                        // may be free again at once, and another run right away would repeat
                        // whatever made the lease go.
                        holdLocally(job, current.consecutiveFailures)
                    }
                    // shutdown: the state is not touched (Р3).
                } catch (writeError: unknown) {
                    // Redis failed on the write: the slot stays due, retried after a local backoff.
                    stateWritten = false
                    holdLocally(job, current.consecutiveFailures)
                    log.warn(
                        { err: writeError, job: job.name },
                        'Scheduler: the job state could not be written',
                    )
                }
                if (outcome === 'failed' || outcome === 'timeout') {
                    reportToSentry(outcome, job.name, ran.err)
                }
                report({
                    job: job.name,
                    slot,
                    trigger: 'schedule',
                    dryRun: false,
                    durationMs: ran.durationMs,
                    matched: ran.result?.matched ?? 0,
                    changed: ran.result?.changed ?? 0,
                    outcome,
                    ...(ran.err === undefined ? {} : { err: ran.err }),
                    ...(stateWritten === undefined ? {} : { stateWritten }),
                })
            },
        )
        flight.done = run
        inFlight = flight
        try {
            const result = await run
            if (result.status === 'busy') {
                report({
                    job: job.name,
                    slot: slotOf(job.schedule, clock.now()),
                    trigger: 'schedule',
                    dryRun: false,
                    durationMs: 0,
                    matched: 0,
                    changed: 0,
                    outcome: 'skipped-locked',
                })
            }
        } finally {
            inFlight = null
        }
    }

    const tick = async (): Promise<void> => {
        for (const job of jobs) {
            if (stopController.signal.aborted) return
            if (disabled.has(job.name)) continue
            try {
                await runScheduled(job)
            } catch (err: unknown) {
                if (isRedisUnavailable(err)) {
                    // Fail-closed: no lease, no run. redis-health reports the incident; one warn
                    // per tick, the remaining jobs wait for the next one.
                    log.warn({ job: job.name }, 'Scheduler: Redis is unavailable, tick skipped')
                    return
                }
                log.error({ err, job: job.name }, 'Scheduler: the job could not be scheduled')
            }
        }
    }

    const runLoop = async (): Promise<void> => {
        while (!stopController.signal.aborted) {
            await tick()
            try {
                await sleep(tickMs * (0.8 + 0.4 * random()), stopController.signal)
            } catch {
                return
            }
        }
    }

    return {
        start(): void {
            if (started || stopController.signal.aborted) return
            started = true
            if (disabled.size > 0) {
                log.info({ disabledJobs: [...disabled] }, 'Scheduler: jobs disabled')
            }
            log.info({ jobs: jobs.map((job) => job.name), tickMs }, 'Scheduler: started')
            loop = runLoop()
        },

        stop(): Promise<void> {
            stopping ??= (async (): Promise<void> => {
                stopController.abort(new SchedulerStoppedError())
                const flight = inFlight
                if (flight !== null) {
                    const drain = new AbortController()
                    const finished = await Promise.race([
                        flight.done.then(
                            () => true,
                            () => true,
                        ),
                        sleep(stopDrainMs, drain.signal).then(
                            () => false,
                            () => false,
                        ),
                    ])
                    drain.abort()
                    if (!finished) {
                        // Р10: SQL may still be running; the key stays to its TTL so no other
                        // replica starts in the middle of it. The wrapper's release is then a no-op.
                        try {
                            flight.lease?.abandon()
                        } catch (err: unknown) {
                            log.warn({ err }, 'Scheduler: the job lease could not be abandoned')
                        }
                        log.warn(
                            { stopDrainMs },
                            'Scheduler: the job did not stop within the drain; its lease is left to expire',
                        )
                        return
                    }
                }
                await loop
            })()
            return stopping
        },

        tick,

        async runOnce(name, options = {}): Promise<RunOnceResult> {
            const job = jobs.find((candidate) => candidate.name === name)
            if (job === undefined) throw new Error(`Unknown job "${name}"`)
            if (disabled.has(name)) {
                log.warn({ job: name }, 'Scheduler: running a job disabled for the schedule')
            }
            const dryRun = options.dryRun ?? false
            const slot = slotOf(job.schedule, clock.now())
            const leased = await withLease(
                { name, timeoutMs: job.timeoutMs, signal: options.signal },
                (scope) => execute(job, scope, slot, dryRun),
            )
            if (leased.status === 'busy') {
                report({
                    job: name,
                    slot,
                    trigger: 'manual',
                    dryRun,
                    durationMs: 0,
                    matched: 0,
                    changed: 0,
                    outcome: 'skipped-locked',
                })
                return { outcome: 'skipped-locked', matched: 0, changed: 0 }
            }
            const ran = leased.value
            reportToSentry(ran.outcome, name, ran.err)
            const matched = ran.result?.matched ?? 0
            const changed = ran.result?.changed ?? 0
            report({
                job: name,
                slot,
                trigger: 'manual',
                dryRun,
                durationMs: ran.durationMs,
                matched,
                changed,
                outcome: ran.outcome,
                ...(ran.err === undefined ? {} : { err: ran.err }),
            })
            return {
                outcome: ran.outcome,
                matched,
                changed,
                ...(ran.err === undefined ? {} : { error: ran.err }),
            }
        },
    }
}
