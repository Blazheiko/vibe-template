import { eq, inArray, sql } from 'drizzle-orm'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

import { hasPg } from '../../../test-support/pg-test-db.js'

// feat-114 (R11b) on real PostgreSQL. The embedding call is held open by the test, so the order in
// which indexings finish is chosen, not hoped for:
// - two updates with the same updated_at: the older indexing finishing last stores nothing;
// - a screenshot change during indexing does not make the vector stale;
// - reindexAll racing an update does not store the vector of the old text;
// - a failed re-index leaves the article not indexed, not with the old text's vector.

interface Pending {
    text: string
    resolve: (vector: number[]) => void
    reject: (error: Error) => void
}

const embedding = vi.hoisted(() => ({
    single: [] as Pending[],
    batches: [] as { texts: string[]; resolve: (vectors: number[][]) => void }[],
}))
vi.mock('#app/services/ai/adapters/openai-embedding-adapter.js', () => ({
    openaiEmbeddingAdapter: {
        isConfigured: () => true,
        embed: (text: string) =>
            new Promise<number[]>((resolve, reject) => {
                embedding.single.push({ text, resolve, reject })
            }),
        embedBatch: (texts: string[]) =>
            new Promise<number[][]>((resolve) => {
                embedding.batches.push({ texts, resolve })
            }),
    },
}))
vi.mock('#app/services/ai/usage/llm-usage-service.js', () => ({
    llmUsageService: { textUsageRecorder: () => () => undefined },
}))
const silent = vi.hoisted(() => {
    const logger = {
        error: () => undefined,
        warn: () => undefined,
        info: () => undefined,
        debug: () => undefined,
        child: (): unknown => logger,
    }
    return logger
})
vi.mock('#logger', () => ({ default: silent }))

const until = async (condition: () => boolean): Promise<void> => {
    for (let i = 0; i < 200 && !condition(); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5))
    }
    if (!condition()) throw new Error('condition not reached')
}

describe.skipIf(!hasPg)('KB embedding consistency (feat-114)', async () => {
    const { db, pool } = await import('#database/db.js')
    const { supportKnowledgeBase } = await import('#database/schema.js')
    const { supportKnowledgeRepository } = await import('#app/repositories/index.js')
    const { supportEmbeddingService } =
        await import('#app/services/support/support-embedding-service.js')
    const { knowledgeBaseService } = await import('#app/services/support/knowledge-base-service.js')

    const unit = (index: number): number[] =>
        Array.from({ length: 1536 }, (_, i) => (i === index ? 1 : 0))
    const created: bigint[] = []

    // Every indexing the service starts in the background, to wait for its end.
    const indexings: Promise<boolean>[] = []
    const original = supportEmbeddingService.indexArticle.bind(supportEmbeddingService)
    const watchIndexing = (): void => {
        vi.spyOn(supportEmbeddingService, 'indexArticle').mockImplementation((article) => {
            const run = original(article)
            indexings.push(run)
            return run
        })
    }

    const createArticle = async (title: string) => {
        const row = await supportKnowledgeRepository.create({ title, content: `${title} v1` })
        created.push(row.id)
        return row
    }

    // Which unit vector the stored embedding is (distance 0), or null without one.
    const storedVector = async (id: bigint): Promise<number | null> => {
        const [row] = await db
            .select({
                hasEmbedding: sql<boolean>`${supportKnowledgeBase.embedding} IS NOT NULL`,
                index: sql<number | null>`(
                    SELECT i FROM generate_series(0, 9) AS i
                    WHERE ${supportKnowledgeBase.embedding} <=> (
                        SELECT array_agg(CASE WHEN g = i THEN 1 ELSE 0 END ORDER BY g)::vector
                        FROM generate_series(0, 1535) AS g
                    ) < 0.0001
                )`,
            })
            .from(supportKnowledgeBase)
            .where(eq(supportKnowledgeBase.id, id))
        return row?.hasEmbedding === true ? (row.index ?? -1) : null
    }

    const versionOf = async (id: bigint) => {
        const [row] = await db
            .select({
                version: supportKnowledgeBase.contentVersion,
                updatedAt: supportKnowledgeBase.updatedAt,
            })
            .from(supportKnowledgeBase)
            .where(eq(supportKnowledgeBase.id, id))
        if (row === undefined) throw new Error('article gone')
        return row
    }

    afterEach(() => {
        vi.useRealTimers()
        vi.restoreAllMocks()
        embedding.single.length = 0
        embedding.batches.length = 0
        indexings.length = 0
    })

    afterAll(async () => {
        if (created.length > 0) {
            await db.delete(supportKnowledgeBase).where(inArray(supportKnowledgeBase.id, created))
        }
        await pool.end()
    })

    it('two updates with the same updated_at: the older indexing ending last stores nothing', async () => {
        const article = await createArticle('same-clock')
        watchIndexing()
        vi.useFakeTimers({ toFake: ['Date'] })
        vi.setSystemTime(new Date('2026-11-04T12:00:00.000Z'))

        await knowledgeBaseService.update(article.id, { content: 'second text' })
        await knowledgeBaseService.update(article.id, { content: 'third text' })
        await until(() => embedding.single.length === 2)

        const after = await versionOf(article.id)
        expect(after.version).toBe(3)
        expect(after.updatedAt.toISOString()).toBe('2026-11-04T12:00:00.000Z')
        expect(embedding.single.map((call) => call.text)).toEqual([
            'same-clock\n\nsecond text',
            'same-clock\n\nthird text',
        ])

        // The newer text finishes first, the older one last.
        embedding.single[1]?.resolve(unit(3))
        embedding.single[0]?.resolve(unit(2))
        expect(await Promise.all(indexings)).toEqual([false, true])

        expect(await storedVector(article.id)).toBe(3)
    })

    it('a screenshot change during indexing does not make the vector stale', async () => {
        const article = await createArticle('screenshot')
        watchIndexing()

        const reindex = knowledgeBaseService.reindexArticle(article.id)
        await until(() => embedding.single.length === 1)
        await supportKnowledgeRepository.replaceScreenshot(article.id, {
            key: 'kb/x.png',
            mime: 'image/png',
        })
        embedding.single[0]?.resolve(unit(4))

        const result = await reindex
        expect(result.isOk() && result.value).toEqual({ indexed: 1 })
        expect(await storedVector(article.id)).toBe(4)
        expect((await versionOf(article.id)).version).toBe(1)
    })

    it('reindexAll racing an update does not store the vector of the old text', async () => {
        const article = await createArticle('reindex-all')
        const others = supportKnowledgeRepository.findActiveAll.bind(supportKnowledgeRepository)
        vi.spyOn(supportKnowledgeRepository, 'findActiveAll').mockImplementation(async () =>
            (await others()).filter((row) => row.id === article.id),
        )
        watchIndexing()

        const all = supportEmbeddingService.reindexAll()
        await until(() => embedding.batches.length === 1)
        await knowledgeBaseService.update(article.id, { title: 'reindex-all renamed' })
        await until(() => embedding.single.length === 1)

        // reindexAll read version 1 and finishes after the update moved to version 2.
        embedding.batches[0]?.resolve([unit(5)])
        // feat-119 (F5): the stale vector was refused, so this run indexed nothing.
        expect(await all).toBe(0)
        expect(await storedVector(article.id)).toBeNull()

        embedding.single[0]?.resolve(unit(6))
        await Promise.all(indexings)
        expect(await storedVector(article.id)).toBe(6)
    })

    it('a failed re-index leaves the article not indexed, not with the old vector', async () => {
        const article = await createArticle('failing')
        expect(await supportKnowledgeRepository.setEmbedding(article.id, unit(7), 1)).toBe(true)
        watchIndexing()

        const result = await knowledgeBaseService.update(article.id, { content: 'new text' })
        expect(result.isOk() && result.value.item.embeddingIndexed).toBe(false)
        // Not searchable with the old text's vector from the update on.
        expect(await storedVector(article.id)).toBeNull()

        await until(() => embedding.single.length === 1)
        embedding.single[0]?.reject(new Error('provider down'))
        await expect(Promise.all(indexings)).rejects.toThrow('provider down')

        expect(await storedVector(article.id)).toBeNull()
        const listed = await knowledgeBaseService.getById(article.id)
        expect(listed.isOk() && listed.value.item.embeddingIndexed).toBe(false)
    })

    it('a change of category or isActive keeps the version and the vector', async () => {
        const article = await createArticle('metadata')
        expect(await supportKnowledgeRepository.setEmbedding(article.id, unit(8), 1)).toBe(true)

        await knowledgeBaseService.update(article.id, { category: 'billing', isActive: false })

        expect((await versionOf(article.id)).version).toBe(1)
        expect(await storedVector(article.id)).toBe(8)
        expect(embedding.single).toHaveLength(0)
    })
})
