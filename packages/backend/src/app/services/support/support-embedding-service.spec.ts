import { afterEach, describe, expect, it, vi } from 'vitest'

const embedBatch = vi.fn((texts: string[]) => Promise.resolve(texts.map(() => [0.1])))
const embed = vi.fn(() => Promise.resolve([0.2]))
vi.mock('#app/services/ai/adapters/openai-embedding-adapter.js', () => ({
    openaiEmbeddingAdapter: { isConfigured: () => true, embed, embedBatch },
}))
const repository = {
    findActiveAll: vi.fn(),
    setEmbedding: vi.fn(() => Promise.resolve(true)),
    searchByEmbedding: vi.fn(() => Promise.resolve([])),
}
vi.mock('#app/repositories/index.js', () => ({ supportKnowledgeRepository: repository }))
vi.mock('#app/services/ai/usage/llm-usage-service.js', () => ({
    llmUsageService: { textUsageRecorder: vi.fn(() => vi.fn()) },
}))
vi.mock('#config/support.js', () => ({
    default: { embeddingBatchSize: 50, searchMaxDistance: 0.6 },
}))
vi.mock('#logger', () => ({ default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }))

const { supportEmbeddingService } = await import('./support-embedding-service.js')

afterEach(() => {
    vi.clearAllMocks()
})

describe('supportEmbeddingService (code-issues item 54)', () => {
    it('reindexes 120 articles in 3 batches of at most 50 and stores every vector', async () => {
        repository.findActiveAll.mockResolvedValue(
            Array.from({ length: 120 }, (_, i) => ({
                id: BigInt(i + 1),
                title: 't',
                content: 'c',
                contentVersion: i + 2,
            })),
        )

        const count = await supportEmbeddingService.reindexAll()

        expect(count).toBe(120)
        expect(embedBatch.mock.calls.map((call) => call[0].length)).toEqual([50, 50, 20])
        expect(repository.setEmbedding).toHaveBeenCalledTimes(120)
        expect(repository.setEmbedding).toHaveBeenLastCalledWith(120n, [0.1], 121)
    })

    it('searches with the configured maximum distance', async () => {
        await supportEmbeddingService.search('question', 5)
        expect(repository.searchByEmbedding).toHaveBeenCalledWith([0.2], 5, 0.6)
    })

    it('stores the vector with the version of the text it was made from (feat-114)', async () => {
        const article = { id: 7n, title: 'T', content: 'C', contentVersion: 3 }

        expect(await supportEmbeddingService.indexArticle(article)).toBe(true)
        expect(embed).toHaveBeenCalledWith('T\n\nC', expect.anything())
        expect(repository.setEmbedding).toHaveBeenCalledWith(7n, [0.2], 3)
    })

    it('reports a vector of a text that changed meanwhile as not stored (feat-114)', async () => {
        repository.setEmbedding.mockResolvedValueOnce(false)

        expect(
            await supportEmbeddingService.indexArticle({
                id: 7n,
                title: 'T',
                content: 'C',
                contentVersion: 3,
            }),
        ).toBe(false)
    })

    // feat-119 (F3): a lease lost during the provider wait stops the write.
    it('writes nothing when the signal aborts during the provider wait', async () => {
        const controller = new AbortController()
        embed.mockImplementationOnce(() => {
            controller.abort(new Error('lock lost'))
            return Promise.resolve([0.2])
        })

        await expect(
            supportEmbeddingService.indexArticle(
                { id: 7n, title: 'T', content: 'C', contentVersion: 1 },
                { signal: controller.signal },
            ),
        ).rejects.toThrow('lock lost')

        expect(repository.setEmbedding).not.toHaveBeenCalled()
        expect(embed).toHaveBeenCalledWith(
            'T\n\nC',
            expect.objectContaining({ signal: controller.signal }),
        )
    })

    // feat-119 (F5): the count is of the vectors written.
    it('reindexAll counts only the vectors stored', async () => {
        repository.findActiveAll.mockResolvedValue(
            [1, 2, 3].map((i) => ({ id: BigInt(i), title: 't', content: 'c', contentVersion: 1 })),
        )
        repository.setEmbedding
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce(true)

        expect(await supportEmbeddingService.reindexAll()).toBe(2)
    })
})
