import { env } from 'node:process'

import { EMBEDDING_COLUMN_DIMENSIONS } from '../database/embedding-dimensions.js'

export const AI_TEXT_DRIVERS = ['openai', 'xai', 'mistral'] as const
export type AiTextDriver = (typeof AI_TEXT_DRIVERS)[number]

const errors: string[] = []

// An unknown driver used to fall back to Mistral silently (code-issues item 50).
const readTextDriver = (): AiTextDriver => {
    const raw = (env['AI_TEXT_DRIVER'] ?? '').trim()
    if (raw === '') return 'openai'
    if ((AI_TEXT_DRIVERS as readonly string[]).includes(raw)) return raw as AiTextDriver
    errors.push(`AI_TEXT_DRIVER must be one of ${AI_TEXT_DRIVERS.join(', ')}, got "${raw}"`)
    return 'openai'
}

// Upper bound for one provider call (code-issues item 51).
const readTimeoutMs = (): number => {
    const raw = env['AI_REQUEST_TIMEOUT_MS']
    if (raw === undefined || raw.trim() === '') return 60_000
    const value = Number(raw.trim())
    if (!/^\d+$/.test(raw.trim()) || !Number.isSafeInteger(value) || value < 1000) {
        errors.push(`AI_REQUEST_TIMEOUT_MS must be an integer >= 1000, got "${raw}"`)
        return 60_000
    }
    return value
}

// The embedding column has a fixed size (code-issues item 54).
const readEmbeddingDimensions = (): number => {
    const raw = env['OPENAI_EMBEDDING_DIMENSIONS']
    if (raw === undefined || raw.trim() === '') return EMBEDDING_COLUMN_DIMENSIONS
    const value = Number(raw.trim())
    if (value !== EMBEDDING_COLUMN_DIMENSIONS) {
        errors.push(
            `OPENAI_EMBEDDING_DIMENSIONS must be ${String(EMBEDDING_COLUMN_DIMENSIONS)} to match ` +
                `support_knowledge_base.embedding, got "${raw}" (another size needs a column migration and a reindex)`,
        )
        return EMBEDDING_COLUMN_DIMENSIONS
    }
    return value
}

// Prompts are cached per process; other instances see an update within this time
// (code-issues item 43).
const readPromptCacheTtlMs = (): number => {
    const raw = env['PROMPT_CACHE_TTL_MS']
    if (raw === undefined || raw.trim() === '') return 60_000
    const value = Number(raw.trim())
    if (!/^\d+$/.test(raw.trim()) || !Number.isSafeInteger(value) || value < 1000) {
        errors.push(`PROMPT_CACHE_TTL_MS must be an integer >= 1000, got "${raw}"`)
        return 60_000
    }
    return value
}

// A whole number of tokens; 0 is allowed (see the callers).
const readTokenCount = (name: string, fallback: number): number => {
    const raw = env[name]
    if (raw === undefined || raw.trim() === '') return fallback
    const value = Number(raw.trim())
    if (!/^\d+$/.test(raw.trim()) || !Number.isSafeInteger(value)) {
        errors.push(`${name} must be a non-negative integer, got "${raw}"`)
        return fallback
    }
    return value
}

// Strict: a typo must not switch on the keeping of prompts.
const readStrictBoolean = (name: string, fallback: boolean): boolean => {
    const raw = env[name]
    if (raw === undefined || raw.trim() === '') return fallback
    const value = raw.trim().toLowerCase()
    if (value === 'true') return true
    if (value === 'false') return false
    errors.push(`${name} must be true or false, got "${raw}"`)
    return fallback
}

const readPositiveInt = (name: string, fallback: number): number => {
    const raw = env[name]
    if (raw === undefined || raw.trim() === '') return fallback
    const value = Number(raw.trim())
    if (!/^\d+$/.test(raw.trim()) || !Number.isSafeInteger(value) || value < 1) {
        errors.push(`${name} must be an integer >= 1, got "${raw}"`)
        return fallback
    }
    return value
}

const aiConfig = Object.freeze({
    drivers: {
        text: readTextDriver(),
    },
    requestTimeoutMs: readTimeoutMs(),
    // What llm_text_usage keeps of a prompt (feat-065). The usage log is an audit of tokens
    // and cost; a prompt holds what the user wrote (for the support chat, also their history),
    // so by default only its SHA-256 and its length are kept. The text is opt-in, and then
    // `llm:purge-prompts` removes what is older than the retention.
    usage: {
        storePrompts: readStrictBoolean('AI_USAGE_STORE_PROMPTS', false),
        promptRetentionDays: readPositiveInt('AI_USAGE_PROMPT_RETENTION_DAYS', 30),
    },
    promptCacheTtlMs: readPromptCacheTtlMs(),
    // Tokens a user's support chat may spend per UTC day (ADR 0003). 0 switches the budget
    // off, which production-like environments refuse at startup.
    supportDailyTokenBudget: readTokenCount('AI_SUPPORT_DAILY_TOKEN_BUDGET', 200_000),
    // What a reply may add to the message itself: system prompt, knowledge-base context and
    // chat history, whose size is not known when the message is admitted.
    supportPromptAllowanceTokens: readTokenCount('AI_SUPPORT_PROMPT_ALLOWANCE_TOKENS', 8_000),
    providers: {
        openai: {
            apiKey: env['OPENAI_API_KEY'] ?? '',
            chatModel: env['OPENAI_CHAT_MODEL'] ?? 'gpt-5.4-mini',
            chatApiUrl: env['OPENAI_CHAT_API_URL'] ?? 'https://api.openai.com/v1/chat/completions',
        },
        xai: {
            apiKey: env['XAI_API_KEY'] ?? '',
            chatModel: env['XAI_CHAT_MODEL'] ?? 'grok-4.3',
        },
        mistralai: {
            apiKey: env['MISTRAL_API_KEY'] ?? '',
            textModel: env['MISTRAL_TEXT_MODEL'] ?? 'mistral-medium-latest',
        },
    },
    openaiEmbedding: {
        apiKey: env['OPENAI_API_KEY'] ?? '',
        model: env['OPENAI_EMBEDDING_MODEL'] ?? 'text-embedding-3-small',
        dimensions: readEmbeddingDimensions(),
    },
    configError: errors.length > 0 ? errors.join('; ') : null,
})

export default aiConfig
