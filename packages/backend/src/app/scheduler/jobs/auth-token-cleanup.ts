import authTokenCleanupConfig from '#config/auth-token-cleanup.js'
import {
    authTokenCleanupService,
    type PurgeExpiredOptions,
} from '#app/services/auth/auth-token-cleanup-service.js'
import type { PurgeCounts } from '#app/services/shared/purge-counts.js'

import { defineJob, type Job } from '../job.js'

// feat-223: deletes one-time tokens and SMS challenges whose expires_at is more than
// AUTH_TOKEN_RETENTION in the past (documentation/backend/scheduler.md).

export interface AuthTokenCleanupDeps {
    retentionMs: number
    /**
     * An unreadable AUTH_TOKEN_RETENTION. The server refuses to start on it, but `job:run` does not
     * run that check: the job refuses too, rather than delete with the default retention.
     */
    configError: string | null
    now: () => number
    purgeExpired: (options: PurgeExpiredOptions) => Promise<PurgeCounts>
}

export function createAuthTokenCleanupJob(deps: AuthTokenCleanupDeps): Job {
    return defineJob({
        name: 'auth-token-cleanup',
        schedule: { dailyAt: '03:30' },
        timeout: '10m',
        async run(ctx) {
            if (deps.configError !== null) {
                throw new Error(`Invalid auth token cleanup configuration: ${deps.configError}`)
            }
            const before = new Date(deps.now() - deps.retentionMs)
            // The scheduler logs the outcome with matched/changed; this adds the cut-off.
            ctx.logger.info({ before: before.toISOString() }, 'purging auth tokens expired before')
            return await deps.purgeExpired({
                before,
                dryRun: ctx.dryRun,
                checkpoint: ctx.checkpoint,
            })
        },
    })
}

export const authTokenCleanupJob = createAuthTokenCleanupJob({
    retentionMs: authTokenCleanupConfig.retentionMs,
    configError: authTokenCleanupConfig.configError,
    now: Date.now,
    purgeExpired: (options) => authTokenCleanupService.purgeExpired(options),
})
