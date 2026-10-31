import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Every adapter hands an AbortSignal bounded by AI_REQUEST_TIMEOUT_MS to its
// transport and follows the caller's signal (code-issues item 51).

vi.mock('#config/ai.js', () => ({
    default: {
        drivers: { text: 'openai' },
        requestTimeoutMs: 50,
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

const xaiStreamText = vi.fn()
vi.mock('ai', () => ({
    streamText: xaiStreamText,
    tool: vi.fn(),
    jsonSchema: vi.fn(),
    stepCountIs: vi.fn(),
}))
vi.mock('@ai-sdk/xai', () => ({ createXai: () => ({ responses: (model: string) => model }) }))

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

const drain = async (gen: AsyncGenerator<string, string, undefined>): Promise<void> => {
    const chunks: string[] = []
    for await (const chunk of gen) chunks.push(chunk)
}

const neverResolvingFetch = vi.fn(
    (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => {
                reject(init.signal.reason as Error)
            })
        }),
)

beforeEach(() => {
    vi.stubGlobal('fetch', neverResolvingFetch)
})

afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
})

describe('openai text adapter', () => {
    it('aborts a hanging provider after the timeout', async () => {
        const { openaiTextAdapter } = await import('./openai-text-adapter.js')
        await expect(
            drain(openaiTextAdapter.streamText({ systemPrompt: 's', userPrompt: 'u' })),
        ).rejects.toMatchObject({ name: 'TimeoutError' })
        const init = neverResolvingFetch.mock.calls[0]?.[1]
        expect(init?.signal).toBeInstanceOf(AbortSignal)
    })

    it("stops at once when the caller's signal aborts", async () => {
        const { openaiTextAdapter } = await import('./openai-text-adapter.js')
        const controller = new AbortController()
        const pending = drain(
            openaiTextAdapter.streamText({
                systemPrompt: 's',
                userPrompt: 'u',
                signal: controller.signal,
            }),
        )
        controller.abort()
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    })
})

// AI SDK 7 does not throw on abort: it emits an `abort` part and ends the stream normally,
// and `result.usage` rejects. This fake behaves the same way.
const sdkLikeStreamText = (params: { abortSignal: AbortSignal }): unknown => ({
    stream: (async function* () {
        yield { type: 'text-delta', text: 'partial' }
        if (!params.abortSignal.aborted) {
            await new Promise((resolve) => {
                params.abortSignal.addEventListener('abort', resolve)
            })
        }
        yield { type: 'abort' }
    })(),
    get usage(): Promise<never> {
        return Promise.reject(new Error('usage unavailable after abort'))
    },
})

const rejectOnAbort = (signal: AbortSignal): Promise<never> =>
    new Promise((_resolve, reject) => {
        if (signal.aborted) {
            reject(signal.reason as Error)
            return
        }
        signal.addEventListener('abort', () => {
            reject(signal.reason as Error)
        })
    })

describe('xai text adapter', () => {
    it('turns the SDK abort part into a TimeoutError after the timeout', async () => {
        xaiStreamText.mockImplementation(sdkLikeStreamText)
        const { xaiTextAdapter } = await import('./xai-text-adapter.js')
        const onComplete = vi.fn()
        await expect(
            drain(xaiTextAdapter.streamText({ systemPrompt: 's', userPrompt: 'u' }, onComplete)),
        ).rejects.toMatchObject({ name: 'TimeoutError' })
        expect(onComplete).not.toHaveBeenCalled()
    })

    it("turns the SDK abort part into an AbortError when the caller's signal aborts", async () => {
        xaiStreamText.mockImplementation(sdkLikeStreamText)
        const { xaiTextAdapter } = await import('./xai-text-adapter.js')
        const controller = new AbortController()
        const pending = drain(
            xaiTextAdapter.streamText({
                systemPrompt: 's',
                userPrompt: 'u',
                signal: controller.signal,
            }),
        )
        controller.abort()
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    })

    it('rethrows an error part instead of returning the partial text', async () => {
        xaiStreamText.mockReturnValue({
            stream: (async function* () {
                yield { type: 'error', error: new Error('provider failed') }
            })(),
        })
        const { xaiTextAdapter } = await import('./xai-text-adapter.js')
        await expect(
            drain(xaiTextAdapter.streamText({ systemPrompt: 's', userPrompt: 'u' })),
        ).rejects.toThrow('provider failed')
    })
})

describe('mistral text adapter', () => {
    it('aborts a hanging provider after the timeout', async () => {
        mistralStream.mockImplementation((_request: unknown, options: { signal: AbortSignal }) =>
            rejectOnAbort(options.signal),
        )
        const { mistralaiTextAdapter } = await import('./mistralai-text-adapter.js')
        await expect(
            drain(mistralaiTextAdapter.streamText({ systemPrompt: 's', userPrompt: 'u' })),
        ).rejects.toMatchObject({ name: 'TimeoutError' })
    })

    it("stops at once when the caller's signal aborts", async () => {
        mistralStream.mockImplementation((_request: unknown, options: { signal: AbortSignal }) =>
            rejectOnAbort(options.signal),
        )
        const { mistralaiTextAdapter } = await import('./mistralai-text-adapter.js')
        const controller = new AbortController()
        const pending = drain(
            mistralaiTextAdapter.streamText({
                systemPrompt: 's',
                userPrompt: 'u',
                signal: controller.signal,
            }),
        )
        controller.abort()
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    })
})

describe('openai embedding adapter', () => {
    it('aborts a hanging embed and embedBatch after the timeout', async () => {
        embeddingsCreate.mockImplementation((_request: unknown, options: { signal: AbortSignal }) =>
            rejectOnAbort(options.signal),
        )
        const { openaiEmbeddingAdapter } = await import('./openai-embedding-adapter.js')
        await expect(openaiEmbeddingAdapter.embed('text')).rejects.toMatchObject({
            name: 'TimeoutError',
        })
        await expect(openaiEmbeddingAdapter.embedBatch(['a'])).rejects.toMatchObject({
            name: 'TimeoutError',
        })
    })
})
