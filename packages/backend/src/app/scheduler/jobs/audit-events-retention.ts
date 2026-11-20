import auditEventsRetentionConfig from '#config/audit-events-retention.js'
import {
    auditEventsRetentionService,
    type PurgeAuditEventsOptions,
} from '#app/services/audit/audit-events-retention-service.js'
import type { PurgeCounts } from '#app/services/shared/purge-counts.js'

import { defineJob, type Job } from '../job.js'

// feat-235 (Р9): deletes audit events older than AUDIT_EVENTS_RETENTION_DAYS
// (documentation/backend/audit-log.md).

const DAY_MS = 24 * 60 * 60 * 1000

export interface AuditEventsRetentionDeps {
    retentionDays: number
    batchSize: number
    /**
     * An unreadable variable. The server refuses to start on it, but `job:run` does not run that
     * check: the job refuses too, rather than delete with a default.
     */
    configError: string | null
    now: () => number
    purge: (options: PurgeAuditEventsOptions) => Promise<PurgeCounts>
}

export function createAuditEventsRetentionJob(deps: AuditEventsRetentionDeps): Job {
    return defineJob({
        name: 'audit-events-retention',
        schedule: { dailyAt: '04:00' },
        timeout: '10m',
        async run(ctx) {
            if (deps.configError !== null) {
                throw new Error(`Invalid audit events retention configuration: ${deps.configError}`)
            }
            // Once per run: every batch deletes against the same instant.
            const before = new Date(deps.now() - deps.retentionDays * DAY_MS)
            ctx.logger.info({ before: before.toISOString() }, 'purging audit events before')
            return await deps.purge({
                before,
                dryRun: ctx.dryRun,
                checkpoint: ctx.checkpoint,
                batchSize: deps.batchSize,
            })
        },
    })
}

export const auditEventsRetentionJob = createAuditEventsRetentionJob({
    retentionDays: auditEventsRetentionConfig.retentionDays,
    batchSize: auditEventsRetentionConfig.batchSize,
    configError: auditEventsRetentionConfig.configError,
    now: Date.now,
    purge: (options) => auditEventsRetentionService.purge(options),
})
