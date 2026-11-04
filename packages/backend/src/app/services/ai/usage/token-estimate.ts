import type { TokenUsage } from '#app/services/ai/types.js'

/**
 * Characters / 2, rounded up. A heuristic, not an upper bound: CJK, emoji and code can need
 * more tokens per character. Used where the provider reported nothing: the daily budget's
 * reservation (ADR 0003) and the usage audit of a call without usage (feat-118).
 */
export const tokensOfText = (text: string): number => Math.ceil(text.length / 2)

/** Tokens a call is known to have used: the total, else prompt + completion, else unknown. */
export function reportedTokens(usage: TokenUsage): number | null {
    if (usage.totalTokens !== null) return usage.totalTokens
    if (usage.promptTokens !== null && usage.completionTokens !== null) {
        return usage.promptTokens + usage.completionTokens
    }
    return null
}

/** Whether the provider reported usage the audit can trust as real. */
export const hasReportedUsage = (usage: TokenUsage | null): usage is TokenUsage =>
    usage !== null && reportedTokens(usage) !== null

/** The estimate of a call the provider did not report usage for. */
export function estimatedUsage(prompt: string, outputChars: number | null): TokenUsage {
    const promptTokens = tokensOfText(prompt)
    const completionTokens = outputChars === null ? null : Math.ceil(outputChars / 2)
    return {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + (completionTokens ?? 0),
    }
}
