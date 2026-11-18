import { env } from 'node:process'

import { isJobName } from '#app/scheduler/job.js'
import { parseScheduleDuration } from '#app/scheduler/schedule.js'
import { parseBoolean } from '#vendor/utils/env/parse-boolean.js'

// feat-222 (scheduler plan Р5, Р6): the background job scheduler. The job names of
// SCHEDULER_DISABLED_JOBS are checked against the registry at startup (app/scheduler/jobs).

const TICK_DEFAULT = '30s'
const TICK_MIN_MS = 5_000
const TICK_MAX_MS = 5 * 60_000

export interface SchedulerConfig {
    /** SCHEDULER_ENABLED: whether this process runs the scheduler (default true). */
    enabled: boolean
    /** SCHEDULER_TICK: how often the jobs are checked, ms (default 30s, 5s…5m). */
    tickMs: number
    /** SCHEDULER_DISABLED_JOBS: job names the schedule skips (a manual run still works). */
    disabledJobs: readonly string[]
    configError: string | null
}

export function readSchedulerConfig(source: NodeJS.ProcessEnv = env): SchedulerConfig {
    const errors: string[] = []

    const enabled = parseBoolean('SCHEDULER_ENABLED', source['SCHEDULER_ENABLED'], true)
    if (enabled.error !== null) errors.push(enabled.error)

    const rawTick = source['SCHEDULER_TICK']?.trim() ?? ''
    let tickMs = parseScheduleDuration(TICK_DEFAULT)
    if (rawTick !== '') {
        try {
            const parsed = parseScheduleDuration(rawTick)
            if (parsed < TICK_MIN_MS || parsed > TICK_MAX_MS) {
                errors.push(`SCHEDULER_TICK must be from 5s to 5m, got "${rawTick}"`)
            } else {
                tickMs = parsed
            }
        } catch (error: unknown) {
            errors.push(`SCHEDULER_TICK: ${(error as Error).message}`)
        }
    }

    const disabledJobs = (source['SCHEDULER_DISABLED_JOBS'] ?? '')
        .split(',')
        .map((name) => name.trim())
        .filter((name) => name !== '')
    const malformed = disabledJobs.filter((name) => !isJobName(name))
    if (malformed.length > 0) {
        errors.push(
            `SCHEDULER_DISABLED_JOBS must list kebab-case job names, got ${malformed.map((name) => `"${name}"`).join(', ')}`,
        )
    }

    return {
        enabled: enabled.value,
        tickMs,
        disabledJobs,
        configError: errors.length > 0 ? errors.join('; ') : null,
    }
}

export default Object.freeze(readSchedulerConfig())
