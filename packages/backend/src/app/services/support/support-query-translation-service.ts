import { getTextAdapterForModel } from '#app/services/ai/ai-provider.js'
import { promptService } from '#app/services/ai/prompt-service.js'
import { llmUsageService } from '#app/services/ai/usage/llm-usage-service.js'
import type { TokenUsage } from '#app/services/ai/types.js'
import logger from '#logger'
import supportConfig from '#config/support.js'
import { nonEmpty } from '#vendor/utils/env/non-empty.js'

const { defaultTranslationPrompt, defaultGeneration } = supportConfig

export const supportQueryTranslationService = {
    async translateToEnglish(
        text: string,
        options: {
            userId?: bigint
            signal?: AbortSignal
            /** Receives the usage the provider reported (the daily budget settles with it). */
            onUsage?: (usage: TokenUsage) => void
        } = {},
    ): Promise<string> {
        const model = promptService.getModel('SUPPORT_QUERY_TRANSLATION')
        const temperature =
            promptService.getTemperature('SUPPORT_QUERY_TRANSLATION') ??
            defaultGeneration.SUPPORT_QUERY_TRANSLATION.temperature
        const maxTokens =
            promptService.getMaxTokens('SUPPORT_QUERY_TRANSLATION') ??
            defaultGeneration.SUPPORT_QUERY_TRANSLATION.maxTokens
        const systemPrompt =
            nonEmpty(promptService.getContent('SUPPORT_QUERY_TRANSLATION')) ??
            defaultTranslationPrompt

        const adapter = getTextAdapterForModel(model)
        if (!adapter.isConfigured()) {
            logger.warn(
                'Support query translation: text adapter not configured, using original query',
            )
            return text
        }

        try {
            let result = ''
            for await (const chunk of adapter.streamText(
                {
                    systemPrompt,
                    userPrompt: text,
                    temperature,
                    maxOutputTokens: maxTokens,
                    modelOverride: model ?? undefined,
                    ...(options.signal !== undefined ? { signal: options.signal } : {}),
                },
                llmUsageService.textUsageRecorder(
                    'SUPPORT_QUERY_TRANSLATION',
                    options.userId ?? null,
                    promptService.get('SUPPORT_QUERY_TRANSLATION')?.id ?? null,
                    options.onUsage,
                ),
            )) {
                result += chunk
            }
            const englishQuery = result.trim()
            return englishQuery.length > 0 ? englishQuery : text
        } catch (err) {
            logger.error(
                { err, originalLength: text.length, originalQuery: text },
                'Support: query translation failed, using original',
            )
            return text
        }
    },
}
