import { auditEventsRepository } from '#app/repositories/index.js'
import { noCheckpoint, type Checkpoint } from '#app/services/shared/checkpoint.js'
import type { PurgeCounts } from '#app/services/shared/purge-counts.js'

// feat-235 (Р9): deletes audit events older than AUDIT_EVENTS_RETENTION_DAYS. The only DELETE of
// the log; the trigger of the migration refuses UPDATE, not DELETE.

export const AUDIT_EVENTS_PURGE_BATCH_SIZE = 1000

export interface PurgeAuditEventsOptions {
    /** Events with `occurred_at` before this instant are deleted. */
    before: Date
    /** Count only: `matched` is the number of such events, `changed` is 0. */
    dryRun: boolean
    /** Called immediately before every query; throws to stop between batches. */
    checkpoint?: Checkpoint
    batchSize?: number
}

export const auditEventsRetentionService = {
    /**
     * Deletes batches of `batchSize`, oldest first, until a batch comes back short. Safe to run
     * twice at once: each row is deleted by exactly one of the runs.
     */
    async purge(options: PurgeAuditEventsOptions): Promise<PurgeCounts> {
        const checkpoint = options.checkpoint ?? noCheckpoint
        const batchSize = options.batchSize ?? AUDIT_EVENTS_PURGE_BATCH_SIZE
        if (options.dryRun) {
            checkpoint()
            const matched = await auditEventsRepository.countPurgeable(options.before)
            return { matched, changed: 0 }
        }
        let changed = 0
        for (;;) {
            checkpoint()
            const deleted = await auditEventsRepository.purgeBatch(options.before, batchSize)
            changed += deleted
            if (deleted < batchSize) return { matched: changed, changed }
        }
    },
}
