import { Result } from 'better-result'

import { textAdapter } from '#app/services/ai/ai-provider.js'
import { aiAbortKind } from '#app/services/ai/ai-request-signal.js'
import {
    serviceUnavailable,
    upstreamError,
    upstreamTimeout,
    type AppResult,
} from '#app/services/shared/errors.js'
import { llmUsageService } from '#app/services/ai/usage/llm-usage-service.js'
import logger from '#logger'

// Admin "test this prompt" call (code-issues item 23): goes through the
// configured text adapter only — no own fetch, no fallback to raw OpenAI — and
// maps provider failures to domain errors instead of a generic 500.
export const promptTestService = {
    async run(
        systemPrompt: string,
        message: string,
        signal?: AbortSignal,
        usage?: { userId: bigint | null; llmSystemPromptId: bigint | null },
    ): Promise<AppResult<string>> {
        if (!textAdapter.isConfigured()) {
            return Result.err({
                ...serviceUnavailable(),
                message: 'AI provider is not configured',
            })
        }

        try {
            let result = ''
            for await (const chunk of textAdapter.streamText(
                {
                    systemPrompt,
                    userPrompt: message,
                    temperature: 0.5,
                    maxOutputTokens: 2000,
                    ...(signal !== undefined ? { signal } : {}),
                },
                llmUsageService.textUsageRecorder(
                    'PROMPT_TEST',
                    usage?.userId ?? null,
                    usage?.llmSystemPromptId ?? null,
                ),
            )) {
                result += chunk
            }
            return Result.ok(result)
        } catch (error) {
            const abortKind = aiAbortKind(error)
            if (abortKind === 'aborted') {
                // The client went away: nothing failed upstream and nobody reads the answer.
                logger.info({ model: textAdapter.model }, 'Prompt test cancelled by the client')
            }
            // A provider failure is logged once, with its cause, by mapControllerError.
            return Result.err(
                abortKind === 'timeout' ? upstreamTimeout(error) : upstreamError(error),
            )
        }
    },
}
