import { afterEach, describe, expect, it, vi } from 'vitest'

// feat-028 (code-issues item 53): every AI call produces a usage row; unknown
// counts are NULL, not 0.

const usageConfig = vi.hoisted(() => ({ storePrompts: true, promptRetentionDays: 30 }))
vi.mock('#config/ai.js', () => ({
    default: {
        usage: usageConfig,
        drivers: { text: 'openai' },
        requestTimeoutMs: 1000,
        providers: {
            openai: { apiKey: 'k', chatModel: 'gpt-test', chatApiUrl: 'https://llm.test/chat' },
            xai: { apiKey: 'k', chatModel: 'grok-test' },
            mistralai: { apiKey: 'k', textModel: 'mistral-test' },
        },
        openaiEmbedding: { apiKey: 'k', model: 'emb-test', dimensions: 3 },
        configError: null,
    },
}))
const logger = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }))
vi.mock('#logger', () => ({ default: logger }))

const insertText = vi.fn((_row: unknown) => Promise.resolve())
vi.mock('#app/repositories/index.js', () => ({ llmUsageRepository: { insertText } }))

const mistralStream = vi.fn()
vi.mock('@mistralai/mistralai', () => ({
    Mistral: class {
        chat = { stream: mistralStream }
    },
}))
const embeddingsCreate = vi.fn()
vi.mock('openai', () => ({
    default: class {
        embeddings = { create: embeddingsCreate }
    },
}))

const { llmUsageService } = await import('./llm-usage-service.js')

afterEach(() => {
    vi.clearAllMocks()
    usageConfig.storePrompts = true
})

// feat-065: the usage log is an audit of tokens and cost. A prompt holds what the user wrote
// (and, for the support chat, their chat history), kept for ever and shown to every admin:
// by default only a hash and a length are kept.
describe('llmUsageService.recordText: what is kept of the prompt', () => {
    const PROMPT = '[system]\nBe kind.\n\n[user]\nMy email is jane@example.com'
    const usage = { promptTokens: 3, completionTokens: 4, totalTokens: 7 }
    const record = (): void => {
        llmUsageService.textUsageRecorder('SUPPORT_CHAT', 5n)(usage, 'gpt-test', PROMPT)
    }
    const sha256 = async (text: string): Promise<string> =>
        (await import('node:crypto')).createHash('sha256').update(text, 'utf8').digest('hex')

    it('keeps no text by default, only the hash and the length', async () => {
        usageConfig.storePrompts = false

        record()

        const row = insertText.mock.calls[0]?.[0] as Record<string, unknown>
        expect(row['finalPrompt']).toBe('')
        expect(row['promptSha256']).toBe(await sha256(PROMPT))
        expect(row['promptChars']).toBe(PROMPT.length)
        expect(
            JSON.stringify(row, (_key, item: unknown) =>
                typeof item === 'bigint' ? String(item) : item,
            ),
        ).not.toContain('jane@example.com')
        // The audit itself is intact.
        expect(row).toMatchObject({ feature: 'SUPPORT_CHAT', totalTokens: 7, model: 'gpt-test' })
    })

    it('keeps the text as well, when asked to', async () => {
        usageConfig.storePrompts = true

        record()

        const row = insertText.mock.calls[0]?.[0] as Record<string, unknown>
        expect(row['finalPrompt']).toBe(PROMPT)
        expect(row['promptSha256']).toBe(await sha256(PROMPT))
        expect(row['promptChars']).toBe(PROMPT.length)
    })

    it('counts characters, not UTF-16 units, so it agrees with the database', () => {
        usageConfig.storePrompts = false

        llmUsageService.textUsageRecorder('PROMPT_TEST', null)(usage, 'm', 'a😀b')

        expect((insertText.mock.calls[0]?.[0] as Record<string, unknown>)['promptChars']).toBe(3)
    })

    it('gives the same hash to the same prompt, and another to another', () => {
        usageConfig.storePrompts = false
        const recorder = llmUsageService.textUsageRecorder('PROMPT_TEST', null)

        recorder(usage, 'm', 'one')
        recorder(usage, 'm', 'one')
        recorder(usage, 'm', 'two')

        const hashes = insertText.mock.calls.map(
            (call) => (call[0] as Record<string, unknown>)['promptSha256'],
        )
        expect(hashes[0]).toBe(hashes[1])
        expect(hashes[0]).not.toBe(hashes[2])
    })
})

describe('llmUsageService.textUsageRecorder: the budget hook (feat-063, D2)', () => {
    it('hands the reported usage to onUsage as well as writing the row', () => {
        const onUsage = vi.fn()
        const record = llmUsageService.textUsageRecorder('SUPPORT_CHAT', 5n, null, onUsage)
        const usage = { promptTokens: 3, completionTokens: 4, totalTokens: 7 }

        record(usage, 'gpt-test', 'final')

        expect(onUsage).toHaveBeenCalledWith(usage)
        expect(insertText).toHaveBeenCalledTimes(1)
    })

    it('still writes the row when onUsage throws', () => {
        const record = llmUsageService.textUsageRecorder('SUPPORT_CHAT', 5n, null, () => {
            throw new Error('budget bookkeeping failed')
        })

        expect(() => {
            record({ promptTokens: null, completionTokens: null, totalTokens: null }, 'm', 'p')
        }).not.toThrow()
        expect(insertText).toHaveBeenCalledTimes(1)
    })
})

describe('llmUsageService.textUsageRecorder', () => {
    it('writes one row with the feature, user, prompt and the reported counts', () => {
        const record = llmUsageService.textUsageRecorder('PROMPT_TEST', 5n, 9n)
        record({ promptTokens: 3, completionTokens: 4, totalTokens: 7 }, 'gpt-test', 'final')
        expect(insertText).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: 5n,
                llmSystemPromptId: 9n,
                feature: 'PROMPT_TEST',
                model: 'gpt-test',
                finalPrompt: 'final',
                promptTokens: 3,
                completionTokens: 4,
                totalTokens: 7,
            }),
        )
    })

    it('keeps unknown counts and a missing user as NULL', () => {
        llmUsageService.textUsageRecorder('SUPPORT_EMBEDDING', null)(
            { promptTokens: null, completionTokens: null, totalTokens: null },
            'emb-test',
            'text',
        )
        expect(insertText).toHaveBeenCalledWith(
            expect.objectContaining({ userId: null, promptTokens: null, totalTokens: null }),
        )
    })
})

describe('adapters report usage, known or not', () => {
    it('mistral without usage still calls onComplete with NULL counts and warns', async () => {
        mistralStream.mockResolvedValue(
            (async function* () {
                yield { data: { choices: [{ delta: { content: 'hi' } }] } }
            })(),
        )
        const onComplete = vi.fn()
        const { mistralaiTextAdapter } = await import('../adapters/mistralai-text-adapter.js')
        const chunks: string[] = []
        for await (const chunk of mistralaiTextAdapter.streamText(
            { systemPrompt: 's', userPrompt: 'u' },
            onComplete,
        ))
            chunks.push(chunk)

        expect(onComplete).toHaveBeenCalledWith(
            { promptTokens: null, completionTokens: null, totalTokens: null },
            'mistral-test',
            expect.any(String),
        )
        expect(logger.warn).toHaveBeenCalledWith(
            { model: 'mistral-test' },
            'Mistral adapter: provider reported no usage',
        )
    })

    it('embeddings report prompt/total tokens and NULL completion tokens', async () => {
        embeddingsCreate.mockResolvedValue({
            data: [{ index: 0, embedding: [1, 2, 3] }],
            usage: { prompt_tokens: 6, total_tokens: 6 },
        })
        const onComplete = vi.fn()
        const { openaiEmbeddingAdapter } = await import('../adapters/openai-embedding-adapter.js')
        await openaiEmbeddingAdapter.embed('question', { onComplete })

        expect(onComplete).toHaveBeenCalledWith(
            { promptTokens: 6, completionTokens: null, totalTokens: 6 },
            'emb-test',
            'question',
        )
    })

    it('embeddings without usage report NULL', async () => {
        embeddingsCreate.mockResolvedValue({ data: [{ index: 0, embedding: [1] }] })
        const onComplete = vi.fn()
        const { openaiEmbeddingAdapter } = await import('../adapters/openai-embedding-adapter.js')
        await openaiEmbeddingAdapter.embedBatch(['a', 'b'], { onComplete })

        expect(onComplete.mock.calls[0]?.[0]).toEqual({
            promptTokens: null,
            completionTokens: null,
            totalTokens: null,
        })
    })
})
