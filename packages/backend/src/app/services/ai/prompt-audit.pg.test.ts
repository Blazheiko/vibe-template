import { and, eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { hasPg } from '../../../test-support/pg-test-db.js'
import { auditLogLines, testAdminActor } from '../../../test-support/audit-actor.js'

vi.mock('#logger', () => ({
    default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

// feat-235 (Р3, Р5, Р13): an edit of a prompt and its `ai.prompt.updated` event commit together,
// the "before" is the row locked by the edit, and an edit to the stored values changes nothing.
describe.skipIf(!hasPg)('prompt edits in the audit log', async () => {
    const { db, pool } = await import('#database/db.js')
    const { auditEvents, llmSystemPrompts } = await import('#database/schema.js')
    const { promptRepository } = await import('#app/repositories/index.js')
    const { auditService } = await import('#app/services/audit/audit-service.js')
    const { promptService } = await import('#app/services/ai/prompt-service.js')

    const type = 'SUPPORT_QUERY_TRANSLATION' as const
    let inserted = false

    const eventsOf = (requestId: string | null) =>
        db
            .select()
            .from(auditEvents)
            .where(
                and(
                    eq(auditEvents.targetType, 'llm_prompt'),
                    eq(auditEvents.targetId, type),
                    ...(requestId === null ? [] : [eq(auditEvents.requestId, requestId)]),
                ),
            )
    const stored = async () => {
        const row = await promptRepository.findByType(type)
        if (row === undefined) throw new Error('no prompt')
        return row
    }

    beforeEach(async () => {
        const existing = await promptRepository.findByType(type)
        if (existing === undefined) {
            await db.insert(llmSystemPrompts).values({ type, content: 'initial', model: 'm1' })
            inserted = true
        }
        await db
            .update(llmSystemPrompts)
            .set({ content: 'initial', model: 'm1', temperature: 0.5, maxTokens: 100 })
            .where(eq(llmSystemPrompts.type, type))
        await db.delete(auditEvents).where(eq(auditEvents.targetId, type))
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    afterAll(async () => {
        await db.delete(auditEvents).where(eq(auditEvents.targetId, type))
        if (inserted) await db.delete(llmSystemPrompts).where(eq(llmSystemPrompts.type, type))
        await pool.end()
    })

    it('records one event with the changed fields and the text as a hash and a length', async () => {
        const actor = testAdminActor(7n)
        const revisionBefore = (await stored()).revision
        expect(
            await promptService.update(type, { content: 'secret new text', model: 'm2' }, actor),
        ).toBe(true)
        // Every UPDATE raises the revision the cache compares (feat-235 review).
        expect((await stored()).revision).toBe(revisionBefore + 1)
        expect(promptService.get(type)?.revision).toBe(revisionBefore + 1)

        const events = await eventsOf(actor.requestId)
        expect(events).toHaveLength(1)
        const [event] = events
        expect(event).toMatchObject({
            actorKind: 'user',
            actorUserId: 7n,
            actorRole: 'admin',
            action: 'ai.prompt.updated',
            targetType: 'llm_prompt',
            targetId: type,
            targetUserId: null,
            metadata: null,
        })
        expect(event?.changes).toEqual({
            model: { from: 'm1', to: 'm2' },
            content: {
                changed: true,
                sha256Before: expect.stringMatching(/^[0-9a-f]{64}$/),
                sha256After: expect.stringMatching(/^[0-9a-f]{64}$/),
                charsBefore: 'initial'.length,
                charsAfter: 'secret new text'.length,
            },
        })
        expect(JSON.stringify(event?.changes)).not.toContain('secret new text')
        expect(JSON.stringify(event?.changes)).not.toContain('initial')
        // The cache has the row the UPDATE returned.
        expect(promptService.getContent(type)).toBe('secret new text')
        expect(auditLogLines(actor.logger)).toEqual([
            { audit: { action: 'ai.prompt.updated', targetType: 'llm_prompt', targetId: type } },
        ])
    })

    it('an edit to the stored values runs no UPDATE and writes no event', async () => {
        const before = await stored()
        const actor = testAdminActor()
        const update = vi.spyOn(promptRepository, 'update')

        expect(
            await promptService.update(
                type,
                { content: 'initial', model: 'm1', temperature: 0.5, maxTokens: 100 },
                actor,
            ),
        ).toBe(true)

        expect(update).not.toHaveBeenCalled()
        expect((await stored()).updatedAt).toEqual(before.updatedAt)
        expect((await stored()).revision).toBe(before.revision)
        expect(await eventsOf(actor.requestId)).toEqual([])
        expect(auditLogLines(actor.logger)).toEqual([])
    })

    it('a failed audit insert leaves the prompt as it was and logs nothing', async () => {
        const before = await stored()
        const actor = testAdminActor()
        vi.spyOn(auditService, 'record').mockRejectedValueOnce(new Error('audit insert failed'))

        await expect(promptService.update(type, { content: 'lost' }, actor)).rejects.toThrow(
            'audit insert failed',
        )

        const after = await stored()
        expect(after.content).toBe('initial')
        expect(after.updatedAt).toEqual(before.updatedAt)
        expect(await eventsOf(actor.requestId)).toEqual([])
        expect(auditLogLines(actor.logger)).toEqual([])
    })

    it('of two edits, the one that started first but locked second comes after', async () => {
        const lock = promptRepository.lockByType.bind(promptRepository)
        let secondLocked: () => void = () => undefined
        const secondHasLock = new Promise<void>((resolve) => {
            secondLocked = resolve
        })
        let calls = 0
        vi.spyOn(promptRepository, 'lockByType').mockImplementation(async (...args) => {
            calls += 1
            if (calls === 1) {
                // The first edit's transaction is open; it asks for the lock once the second holds it.
                await secondHasLock
                return lock(...args)
            }
            const row = await lock(...args)
            secondLocked()
            // Hold the lock a little, so the first edit queues on it.
            await new Promise((resolve) => setTimeout(resolve, 50))
            return row
        })
        const first = testAdminActor(1n)
        const second = testAdminActor(2n)

        const a = promptService.update(type, { model: 'from-first' }, first)
        await new Promise((resolve) => setTimeout(resolve, 10))
        const b = promptService.update(type, { model: 'from-second' }, second)
        await Promise.all([a, b])

        const [eventA] = await eventsOf(first.requestId)
        const [eventB] = await eventsOf(second.requestId)
        // The second edit was applied first: its "after" is the first one's "before".
        expect(eventB?.changes).toMatchObject({ model: { from: 'm1', to: 'from-second' } })
        expect(eventA?.changes).toMatchObject({ model: { from: 'from-second', to: 'from-first' } })
        expect(eventA !== undefined && eventB !== undefined).toBe(true)
        expect(eventA!.occurredAt.getTime()).toBeGreaterThanOrEqual(eventB!.occurredAt.getTime())
        expect((await stored()).model).toBe('from-first')
        // The cache ends on the row applied last, whatever order the answers came back in.
        expect(promptService.get(type)?.model).toBe('from-first')
    })
})
