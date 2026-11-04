import { type } from '@arktype/type'
import { CanonicalErrorResponseSchema } from './error-response.js'

// One llm_text_usage row: every started call, however it ended (feat-118). Token counts are an
// estimate when tokensEstimated is true, and null only on rows written before feat-118 without
// reported usage; userId is null for system calls (knowledge-base indexing).
export const TextUsageRowSchema = type({
    id: 'string',
    userId: 'string | null',
    model: 'string',
    feature: "'PROMPT_TEST' | 'SUPPORT_CHAT' | 'SUPPORT_QUERY_TRANSLATION' | 'SUPPORT_EMBEDDING'",
    // null when the text is not kept (AI_USAGE_STORE_PROMPTS=false, or purged): then the SHA-256
    // and the length still identify it. Both are null for a row from before they existed.
    finalPrompt: 'string | null',
    promptSha256: 'string | null',
    promptChars: 'number | null',
    promptTokens: 'number | null',
    completionTokens: 'number | null',
    totalTokens: 'number | null',
    status: "'completed' | 'aborted' | 'failed'",
    tokensEstimated: 'boolean',
    createdAt: 'string',
})
export type TextUsageRow = typeof TextUsageRowSchema.infer

export const GetTextUsageResponseSchema = type.or(
    {
        status: "'success'",
        'message?': 'string',
        'data?': {
            rows: TextUsageRowSchema.array(),
            total: 'number',
            page: 'number',
            limit: 'number',
        },
    },
    CanonicalErrorResponseSchema,
)
export type GetTextUsageResponse = typeof GetTextUsageResponseSchema.infer

export const TextUsageStatRowSchema = type({
    model: 'string',
    feature: 'string',
    totalCalls: 'number',
    /** Sum of the tokens the provider reported. */
    totalTokens: 'number',
    /** Sum of the estimated tokens of calls without reported usage. */
    estimatedTokens: 'number',
    /** Calls the provider reported no usage for (estimated, or null on older rows). */
    callsWithoutUsage: 'number',
    abortedCalls: 'number',
    failedCalls: 'number',
})
export type TextUsageStatRow = typeof TextUsageStatRowSchema.infer

export const GetUsageStatsResponseSchema = type.or(
    {
        status: "'success'",
        'message?': 'string',
        'data?': {
            text: TextUsageStatRowSchema.array(),
        },
    },
    CanonicalErrorResponseSchema,
)
export type GetUsageStatsResponse = typeof GetUsageStatsResponseSchema.infer
