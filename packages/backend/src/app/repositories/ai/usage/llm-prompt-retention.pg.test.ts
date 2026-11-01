import { createHash } from 'node:crypto'

import { eq, inArray, sql } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { hasPg } from '../../../../test-support/pg-test-db.js'

vi.mock('#logger', () => ({
    default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

// feat-065 on a real PostgreSQL: the usage log keeps a hash and a length of a prompt; the text
// is purged by age, or all at once, and the purge keeps the hash and the length of what it
// removes.
describe.skipIf(!hasPg)('llm_text_usage prompt retention on PostgreSQL', async () => {
    const { db, pool } = await import('#database/db.js')
    const { llmTextUsage } = await import('#database/schema.js')
    const { llmUsageRepository } = await import('#app/repositories/index.js')

    const DAY = 86_400_000
    const model = `retention-test-${String(Date.now())}`
    const created: bigint[] = []
    const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

    const insert = async (
        finalPrompt: string,
        ageDays: number,
        extra: { promptSha256?: string | null; promptChars?: number | null } = {},
    ): Promise<bigint> => {
        await llmUsageRepository.insertText({
            model,
            feature: 'SUPPORT_CHAT',
            finalPrompt,
            promptTokens: 10,
            completionTokens: 5,
            totalTokens: 15,
            createdAt: new Date(Date.now() - ageDays * DAY),
            ...extra,
        })
        const [row] = await db
            .select({ id: llmTextUsage.id })
            .from(llmTextUsage)
            .where(eq(llmTextUsage.model, model))
            .orderBy(sql`${llmTextUsage.id} desc`)
            .limit(1)
        if (row === undefined) throw new Error('row not inserted')
        created.push(row.id)
        return row.id
    }
    const rowOf = async (id: bigint) => {
        const [row] = await db.select().from(llmTextUsage).where(eq(llmTextUsage.id, id))
        if (row === undefined) throw new Error('row missing')
        return row
    }

    beforeEach(async () => {
        if (created.length > 0) {
            await db.delete(llmTextUsage).where(inArray(llmTextUsage.id, created.splice(0)))
        }
    })

    afterAll(async () => {
        await db.delete(llmTextUsage).where(eq(llmTextUsage.model, model))
        await pool.end()
    })

    it('has the hash and the length columns', async () => {
        const result = await db.execute<{ column_name: string }>(
            sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'llm_text_usage'`,
        )
        const columns = result.rows.map((row) => row.column_name)

        expect(columns).toEqual(
            expect.arrayContaining(['prompt_sha256', 'prompt_chars', 'final_prompt']),
        )
    })

    it('stores a row without text, with the hash and the length', async () => {
        const id = await insert('', 0, { promptSha256: sha256('secret'), promptChars: 6 })

        const row = await rowOf(id)

        expect(row.finalPrompt).toBe('')
        expect(row.promptSha256).toBe(sha256('secret'))
        expect(row.promptChars).toBe(6)
        expect(row.totalTokens).toBe(15)
    })

    describe('purging the text', () => {
        it('blanks the text older than the cut-off and leaves the recent text', async () => {
            const old = await insert('old prompt with jane@example.com', 40)
            const recent = await insert('recent prompt', 1)

            const result = await llmUsageRepository.purgePromptText({
                olderThan: new Date(Date.now() - 30 * DAY),
                dryRun: false,
            })

            expect(result.matched).toBeGreaterThanOrEqual(1)
            expect((await rowOf(old)).finalPrompt).toBe('')
            expect((await rowOf(recent)).finalPrompt).toBe('recent prompt')
        })

        it('keeps the hash and the length of what it removes, computed like the application does', async () => {
            const text = 'prompt with ünïcode and 😀'
            const id = await insert(text, 40)

            await llmUsageRepository.purgePromptText({
                olderThan: new Date(Date.now() - 30 * DAY),
                dryRun: false,
            })

            const row = await rowOf(id)
            expect(row.finalPrompt).toBe('')
            expect(row.promptSha256).toBe(sha256(text))
            // 25 characters, 26 UTF-16 units: the emoji is one character and two units.
            expect(row.promptChars).toBe(25)
        })

        it('does not overwrite a hash and a length that are already there', async () => {
            const id = await insert('text', 40, { promptSha256: 'f'.repeat(64), promptChars: 999 })

            await llmUsageRepository.purgePromptText({
                olderThan: new Date(Date.now() - 30 * DAY),
                dryRun: false,
            })

            const row = await rowOf(id)
            expect(row.promptSha256).toBe('f'.repeat(64))
            expect(row.promptChars).toBe(999)
        })

        it('leaves the token counts and the other columns alone', async () => {
            const id = await insert('some text', 40)
            const before = await rowOf(id)

            await llmUsageRepository.purgePromptText({
                olderThan: new Date(Date.now() - 30 * DAY),
                dryRun: false,
            })

            const after = await rowOf(id)
            expect({ ...after, finalPrompt: '', promptSha256: null, promptChars: null }).toEqual({
                ...before,
                finalPrompt: '',
                promptSha256: null,
                promptChars: null,
            })
        })

        it('purges everything at once when there is no cut-off', async () => {
            const a = await insert('recent one', 0)
            const b = await insert('recent two', 1)

            await llmUsageRepository.purgePromptText({ olderThan: null, dryRun: false })

            expect((await rowOf(a)).finalPrompt).toBe('')
            expect((await rowOf(b)).finalPrompt).toBe('')
        })

        it('is idempotent: the second run finds nothing to purge', async () => {
            await insert('text', 40)
            await llmUsageRepository.purgePromptText({ olderThan: null, dryRun: false })

            const again = await llmUsageRepository.purgePromptText({
                olderThan: null,
                dryRun: false,
            })

            expect(again.matched).toBe(0)
        })

        it('counts and changes nothing on a dry run', async () => {
            const id = await insert('text to keep for now', 40)

            const result = await llmUsageRepository.purgePromptText({
                olderThan: null,
                dryRun: true,
            })

            expect(result.matched).toBeGreaterThanOrEqual(1)
            const row = await rowOf(id)
            expect(row.finalPrompt).toBe('text to keep for now')
            expect(row.promptSha256).toBeNull()
        })

        it('does not count a row that has no text', async () => {
            await insert('', 40, { promptSha256: sha256('x'), promptChars: 1 })
            await llmUsageRepository.purgePromptText({ olderThan: null, dryRun: false })

            const result = await llmUsageRepository.purgePromptText({
                olderThan: null,
                dryRun: true,
            })

            expect(result.matched).toBe(0)
        })
    })
})
