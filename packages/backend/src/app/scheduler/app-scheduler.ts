import schedulerConfig, { type SchedulerConfig } from '#config/scheduler.js'

import { jobs, resolveDisabledJobs } from './jobs/index.js'
import { createScheduler, type Scheduler, type SchedulerDeps } from './scheduler.js'

// feat-222: the scheduler of the app process and of `job:run`, built from the registry and the
// config. Throws when SCHEDULER_DISABLED_JOBS names a job that does not exist.
export function createAppScheduler(
    config: SchedulerConfig = schedulerConfig,
    overrides: Partial<SchedulerDeps> = {},
): Scheduler {
    return createScheduler({
        jobs,
        disabledJobs: resolveDisabledJobs(config.disabledJobs, overrides.jobs ?? jobs),
        tickMs: config.tickMs,
        ...overrides,
    })
}
