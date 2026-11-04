import { promptService } from '#app/services/ai/prompt-service.js'
import aiConfig from '#config/ai.js'
import supportConfig from '#config/support.js'
import { tokensOfText } from '#app/services/ai/usage/token-estimate.js'

// What a support answer is expected to cost, per paid call (ADR 0003). The reservation is
// this estimate; the settlement replaces it with what the provider reported.

/** The paid calls of one answer, in the order they run. */
export const BUDGET_CALLS = {
    translation: 'translation',
    embedding: 'embedding',
    chat: 'chat',
} as const

// Shared with the usage audit (feat-118).
export { reportedTokens, tokensOfText } from '#app/services/ai/usage/token-estimate.js'

const maxTokensOf = (
    type: 'SUPPORT_SYSTEM' | 'SUPPORT_FIRST_CHAT' | 'SUPPORT_QUERY_TRANSLATION',
): number => promptService.getMaxTokens(type) ?? supportConfig.defaultGeneration[type].maxTokens

/**
 * The estimate of an answer to `message`, or of the greeting (`null`: one answer, no
 * message). The answer carries an allowance for what is unknown at admission: the system
 * prompt, the knowledge-base context and the chat history.
 */
export function estimateSupportParts(message: string | null): Record<string, number> {
    const allowance = aiConfig.supportPromptAllowanceTokens
    if (message === null) {
        return { [BUDGET_CALLS.chat]: allowance + maxTokensOf('SUPPORT_FIRST_CHAT') }
    }

    const messageTokens = tokensOfText(message)
    return {
        [BUDGET_CALLS.translation]: messageTokens + maxTokensOf('SUPPORT_QUERY_TRANSLATION'),
        [BUDGET_CALLS.embedding]: messageTokens,
        [BUDGET_CALLS.chat]: allowance + messageTokens + maxTokensOf('SUPPORT_SYSTEM'),
    }
}
