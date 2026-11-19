import type { JobLeaseResult, WithJobLease } from '#app/scheduler/job-lease.js'
import type { Job } from '#app/scheduler/job.js'
import type { PurgePlan } from '#app/services/ai/usage/prompt-purge-plan.js'
import type { Checkpoint } from '#app/services/shared/checkpoint.js'
import type { PurgeCounts } from '#app/services/shared/purge-counts.js'

// feat-224: what `llm:purge-prompts` does once its flags are planned. It takes the lease of the
// `llm-prompt-retention` job (sched:lease:llm-prompt-retention), so the CLI and the scheduled
// run never purge side by side; it does not touch the schedule state. Exit codes as `job:run`:
// 0 done, 1 failed (timeout, lost lease, an error), 75 busy, 130 interrupted.

export const EXIT_BUSY = 75
export const EXIT_INTERRUPTED = 130

export interface PurgeCliDeps {
    job: Pick<Job, 'name' | 'timeoutMs'>
    withLease: WithJobLease
    purge: (
        options: Pick<PurgePlan, 'olderThan' | 'dryRun'> & { checkpoint: Checkpoint },
    ) => Promise<PurgeCounts>
    /** Aborted by SIGINT/SIGTERM. */
    signal: AbortSignal
    print: (line: string) => void
    printError: (line: string) => void
}

export async function runPromptPurge(plan: PurgePlan, deps: PurgeCliDeps): Promise<number> {
    const scope =
        plan.olderThan === null
            ? 'all stored prompt text'
            : `prompt text before ${plan.olderThan.toISOString()}`
    const interrupted = (): boolean => deps.signal.aborted

    let result: JobLeaseResult<PurgeCounts>
    try {
        result = await deps.withLease(
            { name: deps.job.name, timeoutMs: deps.job.timeoutMs, signal: deps.signal },
            (lease) =>
                deps.purge({
                    olderThan: plan.olderThan,
                    dryRun: plan.dryRun,
                    checkpoint: lease.checkpoint,
                }),
        )
    } catch (error: unknown) {
        if (interrupted()) {
            deps.printError('Interrupted; the rows emptied so far stay emptied.')
            return EXIT_INTERRUPTED
        }
        throw error
    }

    if (result.status === 'busy') {
        deps.print(`Busy: ${deps.job.name} is running elsewhere; try again later.`)
        return EXIT_BUSY
    }
    const counts = result.value
    if (result.signal.aborted) {
        // The run returned, but its lease or its time was gone by then: not a success.
        deps.printError(
            `Stopped before the end (matched ${String(counts.matched)}, changed ${String(counts.changed)}).`,
        )
        return interrupted() ? EXIT_INTERRUPTED : 1
    }
    deps.print(
        plan.dryRun
            ? `Dry run: ${String(counts.matched)} row(s) of ${scope} would be emptied.`
            : `Emptied ${String(counts.changed)} row(s) of ${scope}.`,
    )
    return 0
}
