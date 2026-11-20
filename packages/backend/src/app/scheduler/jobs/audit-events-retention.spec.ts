import { describe, expect, it, vi } from 'vitest'

import type { JobContext } from '../job.js'
import { createAuditEventsRetentionJob } from './audit-events-retention.js'

// feat-235 (Р9): the job computes the cut-off from the retention once and hands the scheduler's
// checkpoint and dry-run flag to the service. The deletes are in audit-events-retention.pg.test.ts.

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.parse('2026-11-20T04:00:00Z')

const context = (dryRun: boolean): JobContext => ({
    signal: new AbortController().signal,
    checkpoint: vi.fn(),
    slot: NOW,
    dryRun,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
})

describe('audit-events-retention job', () => {
    it('runs daily at 04:00 UTC with a 10 minute timeout', () => {
        const job = createAuditEventsRetentionJob({
            retentionDays: 365,
            batchSize: 1000,
            configError: null,
            now: () => NOW,
            purge: vi.fn(),
        })
        expect(job.name).toBe('audit-events-retention')
        expect(job.schedule).toEqual({ dailyAt: '04:00' })
        expect(job.timeoutMs).toBe(10 * 60 * 1000)
    })

    it.each([false, true])('purges events older than the retention (dryRun %s)', async (dryRun) => {
        const purge = vi.fn().mockResolvedValue({ matched: 3, changed: dryRun ? 0 : 3 })
        const now = vi.fn(() => NOW)
        const job = createAuditEventsRetentionJob({
            retentionDays: 90,
            batchSize: 25,
            configError: null,
            now,
            purge,
        })
        const ctx = context(dryRun)

        const result = await job.run(ctx)

        expect(purge).toHaveBeenCalledWith({
            before: new Date(NOW - 90 * DAY),
            dryRun,
            checkpoint: ctx.checkpoint,
            batchSize: 25,
        })
        expect(now).toHaveBeenCalledTimes(1)
        expect(result).toEqual({ matched: 3, changed: dryRun ? 0 : 3 })
    })

    it('refuses to run on a configuration error, deleting nothing', async () => {
        const purge = vi.fn()
        const job = createAuditEventsRetentionJob({
            retentionDays: 365,
            batchSize: 1000,
            configError: 'AUDIT_EVENTS_RETENTION_DAYS: 7 is outside 30..100000',
            now: () => NOW,
            purge,
        })

        await expect(job.run(context(false))).rejects.toThrow(
            'Invalid audit events retention configuration: AUDIT_EVENTS_RETENTION_DAYS',
        )
        expect(purge).not.toHaveBeenCalled()
    })
})
