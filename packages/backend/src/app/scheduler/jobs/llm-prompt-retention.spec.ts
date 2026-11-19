import { describe, expect, it, vi } from 'vitest'

import type { JobContext } from '../job.js'
import { createLlmPromptRetentionJob } from './llm-prompt-retention.js'

// feat-224: the job plans the purge from the AI usage settings, as the CLI does without flags,
// and hands the scheduler's checkpoint and dry-run flag to the service. The SQL is in
// llm-prompt-retention.pg.test.ts.

const DAY = 86_400_000
const NOW = Date.parse('2026-11-19T04:00:00Z')

const context = (dryRun: boolean): JobContext => ({
    signal: new AbortController().signal,
    checkpoint: vi.fn(),
    slot: NOW,
    dryRun,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
})

const make = (usage: { storePrompts: boolean; retentionDays: number }, configError = null) => {
    const purge = vi.fn().mockResolvedValue({ matched: 2, changed: 2 })
    const job = createLlmPromptRetentionJob({ usage, configError, now: () => NOW, purge })
    return { job, purge }
}

describe('llm-prompt-retention job', () => {
    it('runs daily at 04:00 UTC with a 10 minute timeout', () => {
        const { job } = make({ storePrompts: false, retentionDays: 30 })
        expect(job.name).toBe('llm-prompt-retention')
        expect(job.schedule).toEqual({ dailyAt: '04:00' })
        expect(job.timeoutMs).toBe(10 * 60_000)
    })

    it('purges all stored text when prompts are not kept', async () => {
        const { job, purge } = make({ storePrompts: false, retentionDays: 30 })
        const ctx = context(false)

        expect(await job.run(ctx)).toEqual({ matched: 2, changed: 2 })
        expect(purge).toHaveBeenCalledWith({
            olderThan: null,
            dryRun: false,
            checkpoint: ctx.checkpoint,
        })
    })

    it.each([false, true])(
        'purges the text past the retention when prompts are kept (dryRun %s)',
        async (dryRun) => {
            const { job, purge } = make({ storePrompts: true, retentionDays: 7 })
            const ctx = context(dryRun)

            await job.run(ctx)

            expect(purge).toHaveBeenCalledWith({
                olderThan: new Date(NOW - 7 * DAY),
                dryRun,
                checkpoint: ctx.checkpoint,
            })
        },
    )

    it('refuses to run on an AI configuration error, purging nothing', async () => {
        const purge = vi.fn()
        const job = createLlmPromptRetentionJob({
            usage: { storePrompts: true, retentionDays: 7 },
            configError: 'AI_USAGE_PROMPT_RETENTION_DAYS must be >= 1',
            now: () => NOW,
            purge,
        })

        await expect(job.run(context(false))).rejects.toThrow('Invalid AI configuration')
        expect(purge).not.toHaveBeenCalled()
    })
})
