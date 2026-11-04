import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { hasPg } from '../../../test-support/pg-test-db.js'

vi.mock('#logger', () => ({
    default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

// feat-025 (code-issues item 25): embedding writes use the schema objects and
// clearEmbedding is a single atomic statement.
describe.skipIf(!hasPg)('supportKnowledgeRepository embeddings on PostgreSQL', async () => {
    const { db, pool } = await import('#database/db.js')
    const { supportKnowledgeBase } = await import('#database/schema.js')
    const { supportKnowledgeRepository } = await import('#app/repositories/index.js')

    const unit = (index: number): number[] =>
        Array.from({ length: 1536 }, (_, i) => (i === index ? 1 : 0))
    const created: bigint[] = []

    const insertArticle = async (title: string, isActive = true): Promise<bigint> => {
        const [row] = await db
            .insert(supportKnowledgeBase)
            .values({ title, content: `${title} content`, isActive, updatedAt: new Date(0) })
            .returning({ id: supportKnowledgeBase.id })
        if (row === undefined) throw new Error('article not inserted')
        created.push(row.id)
        return row.id
    }

    const embeddingOf = async (id: bigint) => {
        const [row] = await db
            .select({
                hasEmbedding: sql<boolean>`${supportKnowledgeBase.embedding} IS NOT NULL`,
                updatedAt: supportKnowledgeBase.updatedAt,
            })
            .from(supportKnowledgeBase)
            .where(eq(supportKnowledgeBase.id, id))
        return row
    }

    let near = 0n
    let far = 0n
    let inactive = 0n

    beforeAll(async () => {
        near = await insertArticle('near')
        far = await insertArticle('far')
        inactive = await insertArticle('inactive', false)
        await supportKnowledgeRepository.setEmbedding(near, unit(0), 1)
        await supportKnowledgeRepository.setEmbedding(far, unit(1), 1)
        await supportKnowledgeRepository.setEmbedding(inactive, unit(0), 1)
    })

    afterAll(async () => {
        for (const id of created) {
            await db.delete(supportKnowledgeBase).where(eq(supportKnowledgeBase.id, id))
        }
        await pool.end()
    })

    it('setEmbedding stores the vector', async () => {
        expect((await embeddingOf(near))?.hasEmbedding).toBe(true)
    })

    it('searchByEmbedding orders active articles by distance', async () => {
        const result = await supportKnowledgeRepository.searchByEmbedding(unit(0), 5)
        const ours = result.filter((row) => created.includes(row.id))
        expect(ours.map((row) => row.id)).toEqual([near, far])
        expect(ours[0]?.distance).toBeCloseTo(0)
        expect(ours[1]?.distance).toBeCloseTo(1)
        expect(ours[0]).toMatchObject({ title: 'near', content: 'near content' })
    })

    it('searchByEmbedding drops articles farther than maxDistance (item 54)', async () => {
        const result = await supportKnowledgeRepository.searchByEmbedding(unit(0), 5, 0.5)
        const ours = result.filter((row) => created.includes(row.id))
        expect(ours.map((row) => row.id)).toEqual([near])
    })

    it('clearEmbedding drops the vector and bumps updatedAt in one statement', async () => {
        const spy = vi.spyOn(pool, 'query')
        try {
            await supportKnowledgeRepository.clearEmbedding(far)
            expect(spy).toHaveBeenCalledTimes(1)
        } finally {
            spy.mockRestore()
        }
        const row = await embeddingOf(far)
        expect(row?.hasEmbedding).toBe(false)
        expect(row?.updatedAt.getTime()).toBeGreaterThan(0)
    })
})
