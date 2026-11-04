import OpenAI from 'openai'
import aiConfig from '#config/ai.js'
import { aiRequestSignal } from '#app/services/ai/ai-request-signal.js'
import type { TextUsageCompleteHandler } from '#app/services/ai/types.js'
import { auditCall, statusOfError } from '#app/services/ai/usage/usage-audit.js'

const cfg = aiConfig.openaiEmbedding

let client: OpenAI | undefined

function getClient(): OpenAI {
    client ??= new OpenAI({ apiKey: cfg.apiKey })
    return client
}

export interface EmbedOptions {
    signal?: AbortSignal
    /** Called once per request with the provider's usage (code-issues item 53). */
    onComplete?: TextUsageCompleteHandler
}

// Embeddings have no completion tokens. feat-118: the request is audited however it ends; without
// reported usage the prompt tokens are an estimate (characters / 2) and the row says so.
// feat-119 (F4): reading the result is part of the audited call, so a response without the
// vectors is one `failed` row (with the usage it reported), not `completed` followed by an error.
async function audited<T extends { usage?: { prompt_tokens?: number; total_tokens?: number } }, R>(
    request: () => Promise<T>,
    read: (response: T) => R,
    input: string,
    estimateFrom: string,
    onComplete: TextUsageCompleteHandler | undefined,
): Promise<R> {
    const audit =
        onComplete === undefined ? null : auditCall(onComplete, cfg.model, input, estimateFrom)
    try {
        const response = await request()
        const usage = response.usage
        if (usage?.total_tokens !== undefined || usage?.prompt_tokens !== undefined) {
            audit?.keep({
                promptTokens: usage.prompt_tokens ?? null,
                completionTokens: null,
                totalTokens: usage.total_tokens ?? usage.prompt_tokens ?? null,
            })
        }
        const result = read(response)
        audit?.settle('completed', null)
        return result
    } catch (err: unknown) {
        audit?.settle(statusOfError(err), null)
        throw err
    }
}

export const openaiEmbeddingAdapter = {
    isConfigured(): boolean {
        return cfg.apiKey !== ''
    },

    async embed(text: string, options: EmbedOptions = {}): Promise<number[]> {
        return audited(
            () =>
                getClient().embeddings.create(
                    { model: cfg.model, input: text, dimensions: cfg.dimensions },
                    { signal: aiRequestSignal(options.signal) },
                ),
            (response) => {
                const data = response.data[0]
                if (data === undefined) {
                    throw new Error('OpenAI Embedding: empty response')
                }
                return data.embedding
            },
            text,
            text,
            options.onComplete,
        )
    },

    async embedBatch(texts: string[], options: EmbedOptions = {}): Promise<number[][]> {
        if (texts.length === 0) return []

        // final_prompt gets a summary, not up to SUPPORT_EMBEDDING_BATCH_SIZE full articles; an
        // estimate counts every text.
        const totalChars = texts.reduce((sum, text) => sum + text.length, 0)
        return audited(
            () =>
                getClient().embeddings.create(
                    { model: cfg.model, input: texts, dimensions: cfg.dimensions },
                    { signal: aiRequestSignal(options.signal) },
                ),
            (response) => {
                // One vector per text, or the vectors cannot be matched to the articles.
                if (response.data.length !== texts.length) {
                    throw new Error(
                        `OpenAI Embedding: ${String(response.data.length)} vectors for ${String(texts.length)} texts`,
                    )
                }
                const sorted = [...response.data].sort((a, b) => a.index - b.index)
                return sorted.map((d) => d.embedding)
            },
            `[batch: ${String(texts.length)} texts, ${String(totalChars)} chars]`,
            texts.join(''),
            options.onComplete,
        )
    },
}
