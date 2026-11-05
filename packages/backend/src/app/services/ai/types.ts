import type { ToolCallHandler } from '#app/services/actions/types.js'

/** Token counts a provider reported. */
export interface ReportedUsage {
    promptTokens: number
    completionTokens: number
    totalTokens: number
}

/** What the usage log records: `null` means the provider did not report it. */
export interface TokenUsage {
    promptTokens: number | null
    completionTokens: number | null
    totalTokens: number | null
}

export const UNKNOWN_USAGE: TokenUsage = Object.freeze({
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
})

/** How a started provider call ended (feat-118, llm_text_usage.status). */
export type TextCallStatus = 'completed' | 'aborted' | 'failed'

/**
 * The end of a call, given with its usage. Absent means `completed` with the provider's usage.
 * `tokensEstimated`: the provider reported no usage, so `usage` is an estimate (feat-118); the
 * status and the origin of the tokens are independent.
 */
export interface TextCallEnd {
    status: TextCallStatus
    tokensEstimated: boolean
}

export type TextUsageCompleteHandler = (
    usage: TokenUsage,
    model: string,
    finalPrompt: string,
    end?: TextCallEnd,
) => void

export interface TextStreamOptions {
    systemPrompt: string
    userPrompt: string
    temperature?: number
    maxOutputTokens?: number
    modelOverride?: string | undefined
    /**
     * Optional tool-calling handler. When provided, the adapter will pass tools
     * to the LLM and invoke onCall() for each tool call made by the model.
     * Adapters that do not support tool calling must silently ignore this field.
     */
    toolCallHandler?: ToolCallHandler
    /**
     * Cancels the call (HTTP client gone, WS connection closed). Adapters combine it
     * with AI_REQUEST_TIMEOUT_MS via aiRequestSignal.
     */
    signal?: AbortSignal
    /**
     * Called as soon as the provider reports usage, also part of it before the call ends (the
     * first round of a tool call). The usage audit (feat-118) keeps it, so a call cut off
     * afterwards is recorded with real tokens. Adapters that learn usage only at the end may
     * leave it to `onComplete`.
     */
    onUsageReported?: (usage: TokenUsage, details?: UsageReportDetails) => void
}

/**
 * feat-136 (L7): `partial` marks usage that covers only part of the call (the first round of a
 * tool call). It is real, but the call used more: the audit records the call as estimated, and the
 * daily budget keeps its reservation instead of settling on the part.
 */
export interface UsageReportDetails {
    partial: boolean
}

export interface ITextAdapter {
    isConfigured(): boolean
    get model(): string
    streamText(
        opts: TextStreamOptions,
        onComplete?: TextUsageCompleteHandler,
    ): AsyncGenerator<string, string, undefined>
}

export function buildFinalTextPrompt(opts: TextStreamOptions): string {
    return [`[system]`, opts.systemPrompt, ``, `[user]`, opts.userPrompt].join('\n')
}
