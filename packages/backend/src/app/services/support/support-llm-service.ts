import { getTextAdapterForModel } from '#app/services/ai/ai-provider.js'
import { promptService } from '#app/services/ai/prompt-service.js'
import type { TextUsageCompleteHandler } from '#app/services/ai/types.js'
import type { SupportChatRow } from '#app/repositories/index.js'
import { resolveLanguageName } from 'shared/enums'
import logger from '#logger'
import supportConfig from '#config/support.js'
import { nonEmpty } from '#vendor/utils/env/non-empty.js'

function buildNativeLanguageInstruction(langNative: string): string {
    const nativeLanguageName = resolveLanguageName(langNative)
    return [
        `The user's native language code is "${langNative}".`,
        `The user's native language is ${nativeLanguageName}.`,
        `Always answer in ${nativeLanguageName} unless the user explicitly asks you to switch to another language.`,
        `Do not choose the response language from the knowledge base context or article language.`,
    ].join(' ')
}

export const supportLlmService = {
    async *openChatStream(
        langNative: string,
        onComplete?: TextUsageCompleteHandler,
        signal?: AbortSignal,
    ): AsyncGenerator<string, void, undefined> {
        const systemPromptBase =
            nonEmpty(promptService.getContent('SUPPORT_FIRST_CHAT')) ??
            supportConfig.defaultFirstChatPrompt
        const temperature =
            promptService.getTemperature('SUPPORT_FIRST_CHAT') ??
            supportConfig.defaultGeneration.SUPPORT_FIRST_CHAT.temperature
        const maxTokens =
            promptService.getMaxTokens('SUPPORT_FIRST_CHAT') ??
            supportConfig.defaultGeneration.SUPPORT_FIRST_CHAT.maxTokens
        const modelOverride = promptService.getModel('SUPPORT_FIRST_CHAT')
        const adapter = getTextAdapterForModel(modelOverride)
        const systemPrompt = `${systemPromptBase}\n\n${buildNativeLanguageInstruction(langNative)}`

        yield* adapter.streamText(
            {
                systemPrompt,
                userPrompt: 'Start the conversation.',
                temperature,
                maxOutputTokens: maxTokens,
                modelOverride: modelOverride ?? undefined,
                ...(signal !== undefined ? { signal } : {}),
            },
            onComplete,
        )
    },

    async *chatStream(
        userMessage: string,
        knowledgeContext: string,
        chatHistory: SupportChatRow[],
        langNative: string,
        onComplete?: TextUsageCompleteHandler,
        signal?: AbortSignal,
    ): AsyncGenerator<string, void, undefined> {
        const systemPromptTemplate =
            nonEmpty(promptService.getContent('SUPPORT_SYSTEM')) ??
            supportConfig.defaultSystemPrompt
        const temperature =
            promptService.getTemperature('SUPPORT_SYSTEM') ??
            supportConfig.defaultGeneration.SUPPORT_SYSTEM.temperature
        const maxTokens =
            promptService.getMaxTokens('SUPPORT_SYSTEM') ??
            supportConfig.defaultGeneration.SUPPORT_SYSTEM.maxTokens
        const modelOverride = promptService.getModel('SUPPORT_SYSTEM')
        const adapter = getTextAdapterForModel(modelOverride)

        // A function replacement: `$&`, `$'`, `` $` `` and `$$` in admin-written knowledge-base
        // text stay as they are (feat-105).
        let injected = systemPromptTemplate.replace('{context}', () => knowledgeContext)
        if (!systemPromptTemplate.includes('{context}')) {
            logger.warn(
                {
                    templateSource:
                        systemPromptTemplate === supportConfig.defaultSystemPrompt
                            ? 'default'
                            : 'db',
                },
                'Support: {context} placeholder not found in system prompt — appending knowledge base context as fallback',
            )
            injected = `${systemPromptTemplate}\n\nKNOWLEDGE BASE CONTEXT:\n${knowledgeContext}`
        }
        const systemPrompt = [injected, buildNativeLanguageInstruction(langNative)].join('\n\n')

        const historyLines = chatHistory.map((m) => `${m.role}: ${m.content}`).join('\n')

        const userPrompt =
            historyLines.length > 0
                ? `Chat history:\n${historyLines}\n\nuser: ${userMessage}`
                : `user: ${userMessage}`

        yield* adapter.streamText(
            {
                systemPrompt,
                userPrompt,
                temperature,
                maxOutputTokens: maxTokens,
                modelOverride: modelOverride ?? undefined,
                ...(signal !== undefined ? { signal } : {}),
            },
            onComplete,
        )
    },
}
