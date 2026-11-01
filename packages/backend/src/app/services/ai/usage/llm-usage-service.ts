import { llmUsageRepository } from '#app/repositories/index.js'
import type {
    LlmTextUsageRow,
    TextFeature,
    TextStatRow,
    TextFilter,
} from '#app/repositories/index.js'
import logger from '#logger'
import { createHash } from 'node:crypto'
import aiConfig from '#config/ai.js'
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

/** Characters as PostgreSQL's char_length counts them: a surrogate pair is one. */
function countCodePoints(text: string): number {
    let count = 0
    for (let i = 0; i < text.length; i++) {
        const unit = text.charCodeAt(i)
        if (unit >= 0xd800 && unit <= 0xdbff) i++
        count++
    }
    return count
}

/**
 * What the log keeps of a prompt: its SHA-256 and its length in characters (code points, as
 * PostgreSQL's char_length counts, so a later purge computes the same), and the text only when
 * AI_USAGE_STORE_PROMPTS=true. The usage log is an audit of tokens and cost, not an archive of
 * what users wrote.
 */
function promptColumns(prompt: string): {
    finalPrompt: string
    promptSha256: string
    promptChars: number
} {
    return {
        finalPrompt: aiConfig.usage.storePrompts ? prompt : '',
        promptSha256: createHash('sha256').update(prompt, 'utf8').digest('hex'),
        promptChars: countCodePoints(prompt),
    }
}

export const llmUsageService = {
    recordText(params: TextUsageRecord): void {
        void llmUsageRepository
            .insertText({
                userId: params.userId,
                llmSystemPromptId: params.llmSystemPromptId ?? undefined,
                model: params.model,
                feature: params.feature,
                ...promptColumns(params.finalPrompt),
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

    /**
     * Empties the stored prompt text (feat-065), keeping its hash and length. `olderThan: null`
     * purges all of it. With `dryRun` only counts.
     */
    purgePromptText(options: {
        olderThan: Date | null
        dryRun: boolean
    }): Promise<{ matched: number }> {
        return llmUsageRepository.purgePromptText(options)
    },

    async getStats(): Promise<{ text: TextStatRow[] }> {
        const text = await llmUsageRepository.getTextStats()
        return { text }
    },
}
