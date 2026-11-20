import type { Job } from '../job.js'
import { authTokenCleanupJob } from './auth-token-cleanup.js'
import { llmPromptRetentionJob } from './llm-prompt-retention.js'
import { auditEventsRetentionJob } from './audit-events-retention.js'
import { notificationsRetentionJob } from './notifications-retention.js'

// feat-222: the registry of scheduled jobs, run in this order. A job is added here with
// defineJob (documentation/backend/scheduler.md). Names are unique; createScheduler checks it.
export const jobs: readonly Job[] = [
    authTokenCleanupJob,
    llmPromptRetentionJob,
    auditEventsRetentionJob,
    notificationsRetentionJob,
]

/**
 * SCHEDULER_DISABLED_JOBS against the registry: an unknown name stops the startup, so a typo
 * does not leave a job running that was meant to be off.
 */
export function resolveDisabledJobs(
    names: readonly string[],
    registry: readonly Job[] = jobs,
): readonly string[] {
    const known = new Set(registry.map((job) => job.name))
    const unknown = names.filter((name) => !known.has(name))
    if (unknown.length > 0) {
        throw new Error(
            `Invalid scheduler configuration: SCHEDULER_DISABLED_JOBS names unknown job(s) ${unknown.map((name) => `"${name}"`).join(', ')}`,
        )
    }
    return names
}
