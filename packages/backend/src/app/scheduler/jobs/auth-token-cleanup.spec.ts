import { describe, expect, it, vi } from 'vitest'

import type { JobContext } from '../job.js'
import { createAuthTokenCleanupJob } from './auth-token-cleanup.js'

// feat-223: the job computes the cut-off from the retention and hands the scheduler's checkpoint
// and dry-run flag to the service. The deletes themselves are in auth-token-cleanup.pg.test.ts.

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.parse('2026-11-18T03:30:00Z')

const context = (dryRun: boolean): JobContext => ({
    signal: new AbortController().signal,
    checkpoint: vi.fn(),
    slot: NOW,
    dryRun,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
})

describe('auth-token-cleanup job', () => {
    it('runs daily at 03:30 UTC with a 10 minute timeout', () => {
        const job = createAuthTokenCleanupJob({
            retentionMs: 7 * DAY,
            now: () => NOW,
            purgeExpired: vi.fn(),
        })

        expect(job.name).toBe('auth-token-cleanup')
        expect(job.schedule).toEqual({ dailyAt: '03:30' })
        expect(job.timeoutMs).toBe(10 * 60 * 1000)
    })

    it.each([false, true])(
        'purges rows that expired more than the retention ago (dryRun %s)',
        async (dryRun) => {
            const purgeExpired = vi.fn().mockResolvedValue({ matched: 4, changed: dryRun ? 0 : 4 })
            const job = createAuthTokenCleanupJob({
                retentionMs: 7 * DAY,
                now: () => NOW,
                purgeExpired,
            })
            const ctx = context(dryRun)

            const result = await job.run(ctx)

            expect(purgeExpired).toHaveBeenCalledWith({
                before: new Date(NOW - 7 * DAY),
                dryRun,
                checkpoint: ctx.checkpoint,
            })
            expect(result).toEqual({ matched: 4, changed: dryRun ? 0 : 4 })
        },
    )
})
