import notificationsRetentionConfig from '#config/notifications-retention.js'
import {
    notificationsRetentionService,
    type PurgeNotificationsOptions,
} from '#app/services/notifications/notifications-retention-service.js'
import type { PurgeCounts } from '#app/services/shared/purge-counts.js'

import { defineJob, type Job } from '../job.js'

// feat-236 (Р10): deletes notifications older than NOTIFICATIONS_RETENTION_DAYS, read or not
// (documentation/backend/notifications.md).

const DAY_MS = 24 * 60 * 60 * 1000

export interface NotificationsRetentionDeps {
    retentionDays: number
    batchSize: number
    /**
     * An unreadable variable. The server refuses to start on it, but `job:run` does not run that
     * check: the job refuses too, rather than delete with a default.
     */
    configError: string | null
    now: () => number
    purge: (options: PurgeNotificationsOptions) => Promise<PurgeCounts>
}

export function createNotificationsRetentionJob(deps: NotificationsRetentionDeps): Job {
    return defineJob({
        name: 'notifications-retention',
        schedule: { dailyAt: '04:30' },
        timeout: '10m',
        async run(ctx) {
            if (deps.configError !== null) {
                throw new Error(
                    `Invalid notifications retention configuration: ${deps.configError}`,
                )
            }
            // Once per run: every batch deletes against the same instant.
            const before = new Date(deps.now() - deps.retentionDays * DAY_MS)
            ctx.logger.info({ before: before.toISOString() }, 'purging notifications before')
            return await deps.purge({
                before,
                dryRun: ctx.dryRun,
                checkpoint: ctx.checkpoint,
                batchSize: deps.batchSize,
            })
        },
    })
}

export const notificationsRetentionJob = createNotificationsRetentionJob({
    retentionDays: notificationsRetentionConfig.retentionDays,
    batchSize: notificationsRetentionConfig.batchSize,
    configError: notificationsRetentionConfig.configError,
    now: Date.now,
    purge: (options) => notificationsRetentionService.purge(options),
})
