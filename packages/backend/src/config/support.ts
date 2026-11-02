import { env } from 'node:process'
import { isAppLocaleCode } from 'shared/enums'
import { createEnvReader } from '#vendor/utils/env/env-reader.js'

const errors: string[] = []
const reader = createEnvReader()

// Language of the Support AI answers when the client does not send one
// (code-issues item 52).
const readDefaultLanguage = (): string => {
    const raw = (env['SUPPORT_DEFAULT_LANGUAGE'] ?? '').trim().toLowerCase()
    if (raw === '') return 'en'
    if (isAppLocaleCode(raw)) return raw
    errors.push(`SUPPORT_DEFAULT_LANGUAGE must be one of the app locale codes, got "${raw}"`)
    return 'en'
}

// Cosine distance (pgvector <=>, 0..2): articles farther than this are not used
// as context (code-issues item 54). Not calibrated on real embeddings.
const readMaxDistance = (): number => {
    const raw = env['SUPPORT_SEARCH_MAX_DISTANCE']
    if (raw === undefined || raw.trim() === '') return 0.8
    const value = Number(raw.trim())
    if (!Number.isFinite(value) || value <= 0 || value > 2) {
        errors.push(`SUPPORT_SEARCH_MAX_DISTANCE must be a number in (0, 2], got "${raw}"`)
        return 0.8
    }
    return value
}

// Read last: the properties above are what fill `errors` and the reader.
const collectErrors = (): string | null => {
    const all = reader.error === null ? errors : [...errors, reader.error]
    return all.length > 0 ? all.join('; ') : null
}

const supportConfig = Object.freeze({
    defaultLanguage: readDefaultLanguage(),
    embeddingBatchSize: reader.int('SUPPORT_EMBEDDING_BATCH_SIZE', 50, { min: 1, max: 2048 }),
    searchMaxDistance: readMaxDistance(),
    defaultSystemPrompt: `You are a technical support agent for the Vibe Template application.
Your task is to help users understand the application's features.

RULES:
- Answer ONLY based on the provided knowledge base context
- If the context does not contain information about the question, honestly say you do not know and suggest contacting support by email: support@vibe-template.example
- Respond in the user's native language unless the user explicitly asks for another language
- Be polite and specific
- If a relevant article has a screenshot, insert [screenshot:{article_id}] in the response at an appropriate place
- Do not invent features that are not in the context
- Keep answers concise and actionable

KNOWLEDGE BASE CONTEXT:
{context}`,

    defaultFirstChatPrompt: `Greet the user. Introduce yourself as the Vibe Template app support agent.
Briefly describe what you can do: answer questions about app features, show how things work, help with settings.
Ask how you can help.
Respond in the user's native language.
Keep it short - 2-3 sentences max.`,

    defaultTranslationPrompt:
        'Translate the following user support question into English. ' +
        'Return ONLY the English translation, nothing else. ' +
        'If the text is already in English, return it unchanged.',

    // Used when a prompt row has no temperature / max_tokens, and as the values db:seed writes.
    defaultGeneration: Object.freeze({
        SUPPORT_SYSTEM: Object.freeze({ temperature: 0.3, maxTokens: 2048 }),
        SUPPORT_FIRST_CHAT: Object.freeze({ temperature: 0.5, maxTokens: 512 }),
        SUPPORT_QUERY_TRANSLATION: Object.freeze({
            temperature: 0.1,
            maxTokens: 500,
        }),
    }),
    configError: collectErrors(),
})

export default supportConfig
