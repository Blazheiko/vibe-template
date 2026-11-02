import { env } from 'node:process'

import { createEnvReader } from '#vendor/utils/env/env-reader.js'

import { EMBEDDING_COLUMN_DIMENSIONS } from '../database/embedding-dimensions.js'

export const AI_TEXT_DRIVERS = ['openai', 'xai', 'mistral'] as const
export type AiTextDriver = (typeof AI_TEXT_DRIVERS)[number]

const errors: string[] = []
const reader = createEnvReader()

// An unknown driver used to fall back to Mistral silently (code-issues item 50).
const readTextDriver = (): AiTextDriver => {
    const raw = (env['AI_TEXT_DRIVER'] ?? '').trim()
    if (raw === '') return 'openai'
    if ((AI_TEXT_DRIVERS as readonly string[]).includes(raw)) return raw as AiTextDriver
    errors.push(`AI_TEXT_DRIVER must be one of ${AI_TEXT_DRIVERS.join(', ')}, got "${raw}"`)
    return 'openai'
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

// Read last: the properties above are what fill `errors` and the reader.
const collectErrors = (): string | null => {
    const all = reader.error === null ? errors : [...errors, reader.error]
    return all.length > 0 ? all.join('; ') : null
}

const aiConfig = Object.freeze({
    drivers: {
        text: readTextDriver(),
    },
    // Upper bound for one provider call (code-issues item 51).
    requestTimeoutMs: reader.int('AI_REQUEST_TIMEOUT_MS', 60_000, { min: 1000 }),
    // What llm_text_usage keeps of a prompt (feat-065). The usage log is an audit of tokens
    // and cost; a prompt holds what the user wrote (for the support chat, also their history),
    // so by default only its SHA-256 and its length are kept. The text is opt-in, and then
    // `llm:purge-prompts` removes what is older than the retention.
    usage: {
        storePrompts: reader.bool('AI_USAGE_STORE_PROMPTS', false),
        promptRetentionDays: reader.int('AI_USAGE_PROMPT_RETENTION_DAYS', 30, { min: 1 }),
    },
    // Prompts are cached per process; other instances see an update within this time
    // (code-issues item 43).
    promptCacheTtlMs: reader.int('PROMPT_CACHE_TTL_MS', 60_000, { min: 1000 }),
    // Tokens a user's support chat may spend per UTC day (ADR 0003). 0 switches the budget
    // off, which production-like environments refuse at startup.
    supportDailyTokenBudget: reader.int('AI_SUPPORT_DAILY_TOKEN_BUDGET', 200_000, { min: 0 }),
    // What a reply may add to the message itself: system prompt, knowledge-base context and
    // chat history, whose size is not known when the message is admitted.
    supportPromptAllowanceTokens: reader.int('AI_SUPPORT_PROMPT_ALLOWANCE_TOKENS', 8_000, {
        min: 0,
    }),
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
    configError: collectErrors(),
})

export default aiConfig
