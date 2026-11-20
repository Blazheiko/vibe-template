import { notificationRepository } from '#app/repositories/index.js'
import { noCheckpoint, type Checkpoint } from '#app/services/shared/checkpoint.js'
import type { PurgeCounts } from '#app/services/shared/purge-counts.js'

// feat-236 (Р10): deletes notifications older than NOTIFICATIONS_RETENTION_DAYS, read and unread
// alike: one bound, simple to reason about. No signal is sent; a client finds out at its next
// recovery point (ws_ready, the tab shown again, the list opened).

export const NOTIFICATIONS_PURGE_BATCH_SIZE = 1000

export interface PurgeNotificationsOptions {
    /** Notifications with `created_at` before this instant are deleted. */
    before: Date
    /** Count only: `matched` is the number of such notifications, `changed` is 0. */
    dryRun: boolean
    /** Called immediately before every query; throws to stop between batches. */
    checkpoint?: Checkpoint
    batchSize?: number
}

export const notificationsRetentionService = {
    /**
     * Deletes batches of `batchSize`, oldest first, until a batch comes back short. Safe to run
     * twice at once: each row is deleted by exactly one of the runs.
     */
    async purge(options: PurgeNotificationsOptions): Promise<PurgeCounts> {
        const checkpoint = options.checkpoint ?? noCheckpoint
        const batchSize = options.batchSize ?? NOTIFICATIONS_PURGE_BATCH_SIZE
        if (options.dryRun) {
            checkpoint()
            const matched = await notificationRepository.countPurgeable(options.before)
            return { matched, changed: 0 }
        }
        let changed = 0
        for (;;) {
            checkpoint()
            const deleted = await notificationRepository.purgeBatch(options.before, batchSize)
            changed += deleted
            if (deleted < batchSize) return { matched: changed, changed }
        }
    },
}
