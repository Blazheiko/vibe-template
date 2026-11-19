import aiConfig from '#config/ai.js'
import { llmUsageService } from '#app/services/ai/usage/llm-usage-service.js'
import { planPurge, type PurgePlan } from '#app/services/ai/usage/prompt-purge-plan.js'
import type { Checkpoint } from '#app/services/shared/checkpoint.js'
import type { PurgeCounts } from '#app/services/shared/purge-counts.js'

import { defineJob, type Job } from '../job.js'

// feat-224: empties the prompt text of llm_text_usage by the AI usage settings, as
// `llm:purge-prompts` without flags does: with AI_USAGE_STORE_PROMPTS=false all text still in the
// table, with true the text older than AI_USAGE_PROMPT_RETENTION_DAYS. The hash, the length and
// the token counts stay (documentation/backend/ai.md).

export interface LlmPromptRetentionDeps {
    usage: { storePrompts: boolean; retentionDays: number }
    /**
     * An unreadable AI_* setting. The server refuses to start on it, but `job:run` does not run
     * that check: the job refuses too, rather than purge on a fallback.
     */
    configError: string | null
    now: () => number
    purge: (
        options: Pick<PurgePlan, 'olderThan' | 'dryRun'> & { checkpoint: Checkpoint },
    ) => Promise<PurgeCounts>
}

export function createLlmPromptRetentionJob(deps: LlmPromptRetentionDeps): Job {
    return defineJob({
        name: 'llm-prompt-retention',
        schedule: { dailyAt: '04:00' },
        timeout: '10m',
        async run(ctx) {
            if (deps.configError !== null) {
                throw new Error(`Invalid AI configuration: ${deps.configError}`)
            }
            const { olderThan } = planPurge([], deps.usage, new Date(deps.now()))
            // The scheduler logs the outcome with matched/changed; this adds the cut-off.
            ctx.logger.info(
                { olderThan: olderThan?.toISOString() ?? 'all' },
                'purging the stored prompt text',
            )
            return await deps.purge({ olderThan, dryRun: ctx.dryRun, checkpoint: ctx.checkpoint })
        },
    })
}

export const llmPromptRetentionJob = createLlmPromptRetentionJob({
    usage: {
        storePrompts: aiConfig.usage.storePrompts,
        retentionDays: aiConfig.usage.promptRetentionDays,
    },
    configError: aiConfig.configError,
    now: Date.now,
    purge: (options) => llmUsageService.purgePromptText(options),
})
