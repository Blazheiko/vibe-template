import {
    emailLinkVerificationRepository,
    emailVerificationRepository,
    oauthLinkVerificationRepository,
    passwordResetRepository,
    smsAuthChallengeRepository,
} from '#app/repositories/index.js'
import type { ExpiredRowsRepository } from '#app/repositories/auth/expired-rows.js'
import { noCheckpoint, type Checkpoint } from '#app/services/shared/checkpoint.js'
import type { PurgeCounts } from '#app/services/shared/purge-counts.js'

// feat-223: deletes one-time tokens and SMS challenges long past their expiry. Nothing reads
// such a row except to answer "used" or "expired" instead of "invalid" (feat-223 audit in
// documentation/backend/auth.md), so after AUTH_TOKEN_RETENTION it can go.

export const AUTH_TOKEN_CLEANUP_BATCH_SIZE = 1000

const TABLES: readonly ExpiredRowsRepository[] = [
    emailVerificationRepository,
    emailLinkVerificationRepository,
    passwordResetRepository,
    oauthLinkVerificationRepository,
    smsAuthChallengeRepository,
]

export interface PurgeExpiredOptions {
    /** Rows with `expires_at` before this instant are deleted. */
    before: Date
    /** Count only: `matched` is the number of such rows, `changed` is 0. */
    dryRun: boolean
    /** Called immediately before every query; throws to stop between batches. */
    checkpoint?: Checkpoint
    batchSize?: number
}

export const authTokenCleanupService = {
    /**
     * Table by table, deletes batches of `batchSize` until a batch comes back short. Safe to run
     * twice at once: each row is deleted by exactly one of the runs. On a real run `matched`
     * equals `changed`, the rows this run deleted.
     */
    async purgeExpired(options: PurgeExpiredOptions): Promise<PurgeCounts> {
        const checkpoint = options.checkpoint ?? noCheckpoint
        const batchSize = options.batchSize ?? AUTH_TOKEN_CLEANUP_BATCH_SIZE
        let matched = 0
        let changed = 0

        for (const table of TABLES) {
            if (options.dryRun) {
                checkpoint()
                matched += await table.countExpired(options.before)
                continue
            }
            for (;;) {
                checkpoint()
                const deleted = await table.deleteExpiredBatch(options.before, batchSize)
                matched += deleted
                changed += deleted
                if (deleted < batchSize) break
            }
        }

        return { matched, changed }
    },
}
