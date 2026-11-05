import { afterEach, describe, expect, it, vi } from 'vitest'

import type { TokenUsage } from '#app/services/ai/types.js'

// feat-136 (sixth review L6, L7): what an adapter reports as the provider's usage. A usage object
// without token counts is not usage (it used to become 0 real tokens), and the first round of a
// tool call is only part of the call.

vi.mock('#config/ai.js', () => ({
    default: {
        drivers: { text: 'openai' },
        requestTimeoutMs: 5_000,
        providers: {
            openai: { apiKey: 'k', chatModel: 'gpt-test', chatApiUrl: 'https://llm.test/chat' },
            xai: { apiKey: 'k', chatModel: 'grok-test' },
            mistralai: { apiKey: 'k', textModel: 'mistral-test' },
        },
        openaiEmbedding: { apiKey: 'k', model: 'emb', dimensions: 3 },
        configError: null,
    },
}))
vi.mock('#logger', () => ({
    default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))
const mistralStream = vi.fn()
vi.mock('@mistralai/mistralai', () => ({
    Mistral: class {
        chat = { stream: mistralStream }
    },
}))

const drain = async (gen: AsyncGenerator<string, string, undefined>): Promise<void> => {
    for await (const _ of gen) {
        // drained
    }
}

/** An OpenAI chat-completions SSE answer made of these `data:` events. */
const sse = (events: unknown[]) => {
    const text =
        events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n'
    const bytes = new TextEncoder().encode(text)
    return {
        ok: true,
        status: 200,
        text: () => Promise.resolve(text),
        body: new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(bytes)
                controller.close()
            },
        }),
    }
}

afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
})

describe('mistral usage (L6)', () => {
    it('a usage object without token counts is no usage', async () => {
        mistralStream.mockResolvedValue(
            (async function* () {
                yield { data: { choices: [{ delta: { content: 'hi' } }], usage: {} } }
            })(),
        )
        const { mistralaiTextAdapter } = await import('./mistralai-text-adapter.js')
        const reported = vi.fn()
        let completed: TokenUsage | undefined

        await drain(
            mistralaiTextAdapter.streamText(
                { systemPrompt: 's', userPrompt: 'u', onUsageReported: reported },
                (usage) => {
                    completed = usage
                },
            ),
        )

        expect(reported).not.toHaveBeenCalled()
        expect(completed).toEqual({ promptTokens: null, completionTokens: null, totalTokens: null })
    })
})

describe('openai usage (L6, L7)', () => {
    it('a usage object without token counts is no usage', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(() =>
                Promise.resolve(sse([{ choices: [{ delta: { content: 'hi' } }] }, { usage: {} }])),
            ),
        )
        const { openaiTextAdapter } = await import('./openai-text-adapter.js')
        const reported = vi.fn()
        let completed: TokenUsage | undefined

        await drain(
            openaiTextAdapter.streamText(
                { systemPrompt: 's', userPrompt: 'u', onUsageReported: reported },
                (usage) => {
                    completed = usage
                },
            ),
        )

        expect(reported).not.toHaveBeenCalled()
        expect(completed).toEqual({ promptTokens: null, completionTokens: null, totalTokens: null })
    })

    it('the first round of a tool call is reported as partial, and without the second round usage the call has none', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(
                sse([
                    {
                        choices: [
                            {
                                delta: {
                                    tool_calls: [
                                        {
                                            index: 0,
                                            id: 'call-1',
                                            function: { name: 'lookup', arguments: '{}' },
                                        },
                                    ],
                                },
                            },
                        ],
                    },
                    { usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 } },
                ]),
            )
            .mockResolvedValueOnce(sse([{ choices: [{ delta: { content: 'answer' } }] }]))
        vi.stubGlobal('fetch', fetchMock)
        const { openaiTextAdapter } = await import('./openai-text-adapter.js')
        const reported = vi.fn()
        let completed: TokenUsage | undefined

        await drain(
            openaiTextAdapter.streamText(
                {
                    systemPrompt: 's',
                    userPrompt: 'u',
                    onUsageReported: reported,
                    toolCallHandler: {
                        tools: { lookup: { description: 'd', parametersSchema: {} } },
                        onCall: () => Promise.resolve('result'),
                    },
                },
                (usage) => {
                    completed = usage
                },
            ),
        )

        expect(fetchMock).toHaveBeenCalledTimes(2)
        expect(reported).toHaveBeenCalledWith(
            { promptTokens: 100, completionTokens: 5, totalTokens: 105 },
            { partial: true },
        )
        expect(completed).toEqual({ promptTokens: null, completionTokens: null, totalTokens: null })
    })
})

describe('auditCall with partial usage (L7)', () => {
    it('records the call as estimated, never below the part the provider reported', async () => {
        const { auditCall } = await import('#app/services/ai/usage/usage-audit.js')
        const onComplete = vi.fn()
        const audit = auditCall(onComplete, 'gpt-test', 'short prompt')

        audit.keep({ promptTokens: 100, completionTokens: 5, totalTokens: 105 }, { partial: true })
        audit.settle('completed', 12)

        const [usage, , , meta] = onComplete.mock.calls[0] as [
            TokenUsage,
            string,
            string,
            { tokensEstimated: boolean },
        ]
        expect(meta.tokensEstimated).toBe(true)
        expect(usage.promptTokens).toBeGreaterThanOrEqual(100)
        expect(usage.totalTokens).toBeGreaterThanOrEqual(105)
    })
})
