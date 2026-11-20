import { and, eq, inArray, sql } from 'drizzle-orm'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { hasPg } from '../../../test-support/pg-test-db.js'
import { PNG_BYTES } from '../../../test-support/image-fixtures.js'
import { auditLogLines, testAdminActor } from '../../../test-support/audit-actor.js'

// feat-235 (Р3, Р5, Р13) on a real PostgreSQL with an in-memory S3: every change of a
// knowledge-base article commits with its event; the "before" is the locked row; an edit to the
// stored values changes nothing; a screenshot whose event fails leaves no new object behind.

const s3 = vi.hoisted(() => ({ objects: new Map<string, number>() }))
vi.mock('#vendor/utils/storage/s3.js', () => ({
    uploadToS3: (key: string, data: Buffer) => {
        s3.objects.set(key, data.byteLength)
        return Promise.resolve()
    },
    deleteFromS3: (key: string) => {
        s3.objects.delete(key)
        return Promise.resolve()
    },
    buildObjectKey: (key: string) => key,
}))
vi.mock('#logger', () => ({
    default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

const png = { filename: 'a.png', type: 'image/png', data: PNG_BYTES } as never

describe.skipIf(!hasPg)('knowledge-base changes in the audit log', async () => {
    const { db, pool } = await import('#database/db.js')
    const { auditEvents, supportKnowledgeBase } = await import('#database/schema.js')
    const { supportKnowledgeRepository } = await import('#app/repositories/index.js')
    const { auditService } = await import('#app/services/audit/audit-service.js')
    const { supportEmbeddingService } =
        await import('#app/services/support/support-embedding-service.js')
    const { knowledgeBaseService } = await import('#app/services/support/knowledge-base-service.js')

    const articleIds: bigint[] = []

    const eventsOf = (requestId: string) =>
        db.select().from(auditEvents).where(eq(auditEvents.requestId, requestId))
    const rowOf = async (id: bigint) => {
        const [row] = await db
            .select({
                title: supportKnowledgeBase.title,
                content: supportKnowledgeBase.content,
                category: supportKnowledgeBase.category,
                contentVersion: supportKnowledgeBase.contentVersion,
                updatedAt: supportKnowledgeBase.updatedAt,
                screenshotKey: supportKnowledgeBase.screenshotKey,
                hasEmbedding: sql<boolean>`${supportKnowledgeBase.embedding} IS NOT NULL`,
            })
            .from(supportKnowledgeBase)
            .where(eq(supportKnowledgeBase.id, id))
        return row
    }
    const newArticle = async (): Promise<bigint> => {
        const row = await supportKnowledgeRepository.create({
            title: 'Audit',
            content: 'body',
            category: 'general',
        })
        articleIds.push(row.id)
        // An indexed article, so a test can see whether an edit cleared the vector.
        const vector = Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0))
        await supportKnowledgeRepository.setEmbedding(row.id, vector, row.contentVersion)
        return row.id
    }
    const objectsUnder = (id: bigint): string[] =>
        [...s3.objects.keys()].filter((key) => key.startsWith(`knowledge-base/${String(id)}/`))

    let indexArticle: ReturnType<typeof vi.spyOn>
    beforeEach(() => {
        indexArticle = vi.spyOn(supportEmbeddingService, 'indexArticle').mockResolvedValue(true)
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    afterAll(async () => {
        if (articleIds.length > 0) {
            const ids = articleIds.map(String)
            await db
                .delete(auditEvents)
                .where(
                    and(
                        eq(auditEvents.targetType, 'kb_article'),
                        inArray(auditEvents.targetId, ids),
                    ),
                )
            await db
                .delete(supportKnowledgeBase)
                .where(inArray(supportKnowledgeBase.id, articleIds))
        }
        await pool.end()
    })

    it('create, update and delete each write one event', async () => {
        const actor = testAdminActor(3n)
        const created = await knowledgeBaseService.create(
            { title: 'Created', content: 'created body', category: null, isActive: true },
            actor,
        )
        if (!created.isOk()) throw new Error('create failed')
        const id = BigInt(created.value.item.id)
        articleIds.push(id)

        const [createdEvent] = await eventsOf(actor.requestId)
        expect(createdEvent).toMatchObject({
            action: 'kb.article.created',
            actorKind: 'user',
            actorUserId: 3n,
            targetType: 'kb_article',
            targetId: String(id),
        })
        expect(createdEvent?.changes).toMatchObject({
            title: { from: null, to: 'Created' },
            isActive: { from: null, to: true },
            content: { changed: true, sha256Before: null, charsAfter: 'created body'.length },
        })

        const editor = testAdminActor(4n)
        await knowledgeBaseService.update(id, { title: 'Renamed', content: 'new body' }, editor)
        const updatedEvents = await eventsOf(editor.requestId)
        expect(updatedEvents).toHaveLength(1)
        expect(updatedEvents[0]?.action).toBe('kb.article.updated')
        expect(updatedEvents[0]?.changes).toEqual({
            title: { from: 'Created', to: 'Renamed' },
            content: {
                changed: true,
                sha256Before: expect.stringMatching(/^[0-9a-f]{64}$/),
                sha256After: expect.stringMatching(/^[0-9a-f]{64}$/),
                charsBefore: 'created body'.length,
                charsAfter: 'new body'.length,
            },
        })
        expect(JSON.stringify(updatedEvents[0]?.changes)).not.toContain('new body')

        const remover = testAdminActor(5n)
        expect((await knowledgeBaseService.delete(id, remover)).isOk()).toBe(true)
        const deletedEvents = await eventsOf(remover.requestId)
        expect(deletedEvents).toHaveLength(1)
        expect(deletedEvents[0]).toMatchObject({ action: 'kb.article.deleted' })
        expect(deletedEvents[0]?.changes).toMatchObject({
            title: { from: 'Renamed', to: null },
            content: { sha256After: null, charsBefore: 'new body'.length },
        })
        expect(auditLogLines(remover.logger)).toEqual([
            {
                audit: {
                    action: 'kb.article.deleted',
                    targetType: 'kb_article',
                    targetId: String(id),
                },
            },
        ])
    })

    it('an edit to the stored values runs no UPDATE, writes no event and keeps the vector', async () => {
        const id = await newArticle()
        const before = await rowOf(id)
        const actor = testAdminActor()
        const update = vi.spyOn(supportKnowledgeRepository, 'update')

        const result = await knowledgeBaseService.update(
            id,
            { title: 'Audit', content: 'body', category: 'general', isActive: true },
            actor,
        )

        expect(result.isOk()).toBe(true)
        expect(update).not.toHaveBeenCalled()
        expect(await rowOf(id)).toEqual(before)
        expect(before?.hasEmbedding).toBe(true)
        expect(await eventsOf(actor.requestId)).toEqual([])
        expect(auditLogLines(actor.logger)).toEqual([])
        expect(indexArticle).not.toHaveBeenCalled()
    })

    it('a category change alone keeps the content version and the vector', async () => {
        const id = await newArticle()
        const before = await rowOf(id)
        const actor = testAdminActor()

        await knowledgeBaseService.update(id, { title: 'Audit', category: 'billing' }, actor)

        const after = await rowOf(id)
        expect(after?.category).toBe('billing')
        expect(after?.contentVersion).toBe(before?.contentVersion)
        expect(after?.hasEmbedding).toBe(true)
        const [event] = await eventsOf(actor.requestId)
        expect(event?.changes).toEqual({ category: { from: 'general', to: 'billing' } })
        expect(indexArticle).not.toHaveBeenCalled()
    })

    it('a failed audit insert leaves the article as it was and logs nothing', async () => {
        const id = await newArticle()
        const before = await rowOf(id)
        const actor = testAdminActor()
        vi.spyOn(auditService, 'record').mockRejectedValueOnce(new Error('audit insert failed'))

        await expect(knowledgeBaseService.update(id, { content: 'lost' }, actor)).rejects.toThrow(
            'audit insert failed',
        )
        expect(await rowOf(id)).toEqual(before)

        vi.spyOn(auditService, 'record').mockRejectedValueOnce(new Error('audit insert failed'))
        await expect(knowledgeBaseService.delete(id, actor)).rejects.toThrow('audit insert failed')
        expect(await rowOf(id)).toEqual(before)

        expect(await eventsOf(actor.requestId)).toEqual([])
        expect(auditLogLines(actor.logger)).toEqual([])
    })

    it('of two edits, the "after" of the one applied first is the "before" of the other', async () => {
        const id = await newArticle()
        const lock = supportKnowledgeRepository.lockById.bind(supportKnowledgeRepository)
        let secondLocked: () => void = () => undefined
        const secondHasLock = new Promise<void>((resolve) => {
            secondLocked = resolve
        })
        let calls = 0
        vi.spyOn(supportKnowledgeRepository, 'lockById').mockImplementation(async (...args) => {
            calls += 1
            if (calls === 1) {
                await secondHasLock
                return lock(...args)
            }
            const row = await lock(...args)
            secondLocked()
            await new Promise((resolve) => setTimeout(resolve, 50))
            return row
        })
        const first = testAdminActor(1n)
        const second = testAdminActor(2n)

        const a = knowledgeBaseService.update(id, { title: 'From first' }, first)
        await new Promise((resolve) => setTimeout(resolve, 10))
        const b = knowledgeBaseService.update(id, { title: 'From second' }, second)
        await Promise.all([a, b])

        const [eventA] = await eventsOf(first.requestId)
        const [eventB] = await eventsOf(second.requestId)
        expect(eventB?.changes).toEqual({ title: { from: 'Audit', to: 'From second' } })
        expect(eventA?.changes).toEqual({ title: { from: 'From second', to: 'From first' } })
        expect((await rowOf(id))?.title).toBe('From first')
    })

    describe('screenshots', () => {
        it('an upload and a removal each write one event without the S3 key', async () => {
            const id = await newArticle()
            const actor = testAdminActor()
            expect((await knowledgeBaseService.uploadScreenshot(id, png, actor)).isOk()).toBe(true)
            const firstKey = (await rowOf(id))?.screenshotKey

            const replacer = testAdminActor()
            expect((await knowledgeBaseService.uploadScreenshot(id, png, replacer)).isOk()).toBe(
                true,
            )
            const secondKey = (await rowOf(id))?.screenshotKey
            expect(secondKey).not.toBe(firstKey)
            // The old object is gone once the swap committed.
            expect(objectsUnder(id)).toEqual([secondKey])

            const [uploaded] = await eventsOf(replacer.requestId)
            expect(uploaded).toMatchObject({
                action: 'kb.screenshot.uploaded',
                changes: { screenshot: { from: true, to: true } },
                metadata: { mime: 'image/png' },
            })
            expect(JSON.stringify([uploaded?.changes, uploaded?.metadata])).not.toContain(
                'knowledge-base/',
            )
            expect(auditLogLines(replacer.logger)).toHaveLength(1)

            const remover = testAdminActor()
            expect((await knowledgeBaseService.deleteScreenshot(id, remover)).isOk()).toBe(true)
            const [removed] = await eventsOf(remover.requestId)
            expect(removed).toMatchObject({
                action: 'kb.screenshot.removed',
                changes: { screenshot: { from: true, to: false } },
                metadata: { mime: 'image/png' },
            })
            expect(objectsUnder(id)).toEqual([])

            // Removing a screenshot that is not there writes no event.
            const again = testAdminActor()
            expect((await knowledgeBaseService.deleteScreenshot(id, again)).isOk()).toBe(true)
            expect(await eventsOf(again.requestId)).toEqual([])
        })

        it('a failed audit insert keeps the old key and takes the new object back', async () => {
            const id = await newArticle()
            await knowledgeBaseService.uploadScreenshot(id, png, testAdminActor())
            const before = (await rowOf(id))?.screenshotKey
            const actor = testAdminActor()
            vi.spyOn(auditService, 'record').mockRejectedValueOnce(new Error('audit insert failed'))

            await expect(knowledgeBaseService.uploadScreenshot(id, png, actor)).rejects.toThrow(
                'audit insert failed',
            )

            expect((await rowOf(id))?.screenshotKey).toBe(before)
            // No new object left behind: our own code threw before the COMMIT.
            expect(objectsUnder(id)).toEqual([before])
            expect(await eventsOf(actor.requestId)).toEqual([])
            expect(auditLogLines(actor.logger)).toEqual([])
        })

        it('a COMMIT without an answer keeps the new object', async () => {
            const id = await newArticle()
            await knowledgeBaseService.uploadScreenshot(id, png, testAdminActor())
            const swap = supportKnowledgeRepository.replaceScreenshot.bind(
                supportKnowledgeRepository,
            )
            vi.spyOn(supportKnowledgeRepository, 'replaceScreenshot').mockImplementationOnce(
                async (...args) => {
                    await swap(...args)
                    throw new Error('connection lost on COMMIT')
                },
            )

            await expect(
                knowledgeBaseService.uploadScreenshot(id, png, testAdminActor()),
            ).rejects.toThrow('connection lost on COMMIT')

            const key = (await rowOf(id))?.screenshotKey
            expect(objectsUnder(id)).toContain(key)
        })
    })
})
