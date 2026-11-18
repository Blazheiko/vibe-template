import type { Checkpoint } from '#app/services/shared/checkpoint.js'
import type { PurgeCounts } from '#app/services/shared/purge-counts.js'

import { parseScheduleDuration, validateSchedule, type Schedule } from './schedule.js'

// feat-222 (scheduler plan Р7, Р8): the contract of a scheduled job.
//
// A job must be idempotent (a failed run may repeat) and safe to run as two copies at once (a
// lost lease key lets another replica start while this one still works). It calls
// `ctx.checkpoint()` immediately before every SQL step, with no `await` in between, and passes it
// down to the loop that does the work.

export interface JobLogger {
    info(obj: object, msg?: string): void
    warn(obj: object, msg?: string): void
    error(obj: object, msg?: string): void
}

export interface JobContext {
    /** Aborted on a timeout, a lost lease or a shutdown: for waits that take an AbortSignal. */
    signal: AbortSignal
    /** Throws when the job must stop; call it immediately before every SQL step. */
    checkpoint: Checkpoint
    /** The start of the slot being run, in epoch ms. */
    slot: number
    /** Change nothing, only count: `changed` is then 0. */
    dryRun: boolean
    logger: JobLogger
}

export type JobResult = PurgeCounts

export interface JobDefinition {
    /** kebab-case, unique in the registry; part of the Redis keys. */
    name: string
    schedule: Schedule
    /** A duration (`5m`); the run is aborted with `timeout` after it. */
    timeout: string
    run(ctx: JobContext): Promise<JobResult>
}

export interface Job extends JobDefinition {
    readonly timeoutMs: number
}

const JOB_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/

export const isJobName = (name: string): boolean => JOB_NAME_RE.test(name)

/** Checks the name, the schedule and the timeout once, when the module is loaded. */
export function defineJob(definition: JobDefinition): Job {
    if (!isJobName(definition.name)) {
        throw new Error(`Job name "${definition.name}" must be kebab-case`)
    }
    try {
        validateSchedule(definition.schedule)
    } catch (error: unknown) {
        throw new Error(`Job "${definition.name}": ${(error as Error).message}`, { cause: error })
    }
    let timeoutMs: number
    try {
        timeoutMs = parseScheduleDuration(definition.timeout)
    } catch (error: unknown) {
        throw new Error(`Job "${definition.name}" timeout: ${(error as Error).message}`, {
            cause: error,
        })
    }
    return Object.freeze({ ...definition, timeoutMs })
}

export type Outcome =
    'ok' | 'failed' | 'timeout' | 'lease-lost' | 'shutdown' | 'skipped-locked' | 'skipped-backoff'

export type OutcomeCategory = 'success' | 'failure' | 'aborted' | 'skipped'

const CATEGORY: Record<Outcome, OutcomeCategory> = {
    ok: 'success',
    failed: 'failure',
    timeout: 'aborted',
    'lease-lost': 'aborted',
    shutdown: 'aborted',
    'skipped-locked': 'skipped',
    'skipped-backoff': 'skipped',
}

export const categoryOf = (outcome: Outcome): OutcomeCategory => CATEGORY[outcome]
