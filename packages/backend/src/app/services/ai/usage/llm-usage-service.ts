import { llmUsageRepository } from '#app/repositories/index.js'
import type {
    LlmTextUsageRow,
    TextFeature,
    TextStatRow,
    TextFilter,
} from '#app/repositories/index.js'
import logger from '#logger'
import type { TextUsageCompleteHandler, TokenUsage } from '#app/services/ai/types.js'

export type { TextFilter }

export interface TextUsageRecord {
    /** NULL for system calls without a user (knowledge-base indexing). */
    userId: bigint | null
    llmSystemPromptId: bigint | null
    model: string
    feature: TextFeature
    finalPrompt: string
    /** NULL when the provider did not report usage. */
    promptTokens: number | null
    completionTokens: number | null
    totalTokens: number | null
}

export const llmUsageService = {
    recordText(params: TextUsageRecord): void {
        void llmUsageRepository
            .insertText({
                userId: params.userId,
                llmSystemPromptId: params.llmSystemPromptId ?? undefined,
                model: params.model,
                feature: params.feature,
                finalPrompt: params.finalPrompt,
                promptTokens: params.promptTokens,
                completionTokens: params.completionTokens,
                totalTokens: params.totalTokens,
                createdAt: new Date(),
            })
            .catch((err: unknown) => {
                logger.warn({ err }, 'llmUsageService: failed to record text usage')
            })
    },

    /**
     * `onComplete` handler for a text adapter call that records one usage row.
     * `onUsage` sees the same reported usage (the daily budget settles with it); its failure
     * never affects the row or the call.
     */
    textUsageRecorder(
        feature: TextFeature,
        userId: bigint | null,
        llmSystemPromptId: bigint | null = null,
        onUsage?: (usage: TokenUsage) => void,
    ): TextUsageCompleteHandler {
        return (usage, model, finalPrompt) => {
            llmUsageService.recordText({
                userId,
                llmSystemPromptId,
                model,
                feature,
                finalPrompt,
                ...usage,
            })
            try {
                onUsage?.(usage)
            } catch (err) {
                logger.warn({ err }, 'llmUsageService: onUsage failed')
            }
        }
    },

    async getTextUsage(opts: {
        limit: number
        offset: number
        filter?: TextFilter
    }): Promise<{ rows: LlmTextUsageRow[]; total: number }> {
        const filter = opts.filter ?? {}
        const [rows, total] = await Promise.all([
            llmUsageRepository.findText({ limit: opts.limit, offset: opts.offset, ...filter }),
            llmUsageRepository.countText(filter),
        ])
        return { rows, total }
    },

    async getStats(): Promise<{ text: TextStatRow[] }> {
        const text = await llmUsageRepository.getTextStats()
        return { text }
    },
}
