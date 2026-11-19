import { createHash } from 'node:crypto'

import { eq, inArray, sql } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { hasPg } from '../../../../test-support/pg-test-db.js'
import { bothReadBeforeEitherWrites } from '../../../../test-support/race-barrier.js'

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
    const { promptPurgeBatch } = await import('#app/repositories/ai/usage/llm-usage-repository.js')

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

    const insertAt = async (finalPrompt: string, createdAt: Date): Promise<bigint> => {
        const id = await insert(finalPrompt, 0)
        await db.update(llmTextUsage).set({ createdAt }).where(eq(llmTextUsage.id, id))
        return id
    }
    /** Rows of the whole table that still hold text: a purge without a cut-off reaches them all. */
    const countWithText = async (): Promise<number> => {
        const [row] = await db
            .select({ count: sql<number>`count(*)::int` })
            .from(llmTextUsage)
            .where(sql`${llmTextUsage.finalPrompt} <> ''`)
        return row?.count ?? 0
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
        // feat-125 (L10): in batches of short statements, every matching row reached.
        it('purges in batches until nothing matches, and counts every row', async () => {
            const ids: bigint[] = []
            for (let i = 0; i < 7; i += 1) ids.push(await insert(`batched prompt ${String(i)}`, 40))
            const execute = vi.spyOn(db, 'execute')

            const result = await llmUsageRepository.purgePromptText({
                olderThan: new Date(Date.now() - 30 * DAY),
                dryRun: false,
                batchSize: 3,
            })

            expect(result.matched).toBeGreaterThanOrEqual(7)
            expect(result.changed).toBe(result.matched)
            // At least 3 + 3 + 1: one statement per batch, none over the whole table.
            expect(execute.mock.calls.length).toBeGreaterThanOrEqual(3)
            for (const id of ids) expect((await rowOf(id)).finalPrompt).toBe('')
            execute.mockRestore()
        })

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

        // feat-224: the batch comes from the partial index of the rows that still hold text, in
        // created_at order: a purged row leaves it, so a batch reads at most n entries however long
        // the history is. feat-130 paged the whole table by id on every run instead. The tables are
        // small and not analysed here, so a sequential scan and a sort are switched off: the
        // statement must then be able to read its batch from that index in index order.
        it.each([
            ['a cut-off', new Date(Date.now() - 30 * DAY)],
            ['no cut-off', null],
        ])('reads its batch from the partial index (%s)', async (_name, olderThan) => {
            const plan = await db.transaction(async (tx) => {
                await tx.execute(sql`SET LOCAL enable_seqscan = off`)
                await tx.execute(sql`SET LOCAL enable_sort = off`)
                const result = await tx.execute<{ 'QUERY PLAN': string }>(
                    sql`EXPLAIN ${promptPurgeBatch(olderThan, 1000)}`,
                )
                return result.rows.map((row) => row['QUERY PLAN']).join('\n')
            })
            expect(plan).toMatch(/llm_text_usage_prompt_text_created_at_idx/)
            expect(plan).not.toMatch(/Sort/)
        })

        // The cut-off is "at or before": rows a few minutes on either side, and one exactly at it.
        it('draws the line at the cut-off itself, to the minute', async () => {
            const cutoff = new Date(Date.now() - 30 * DAY)
            const minute = 60_000
            const before = await insertAt(
                'two minutes before',
                new Date(cutoff.getTime() - 2 * minute),
            )
            const at = await insertAt('at the cut-off', cutoff)
            const after = await insertAt(
                'two minutes after',
                new Date(cutoff.getTime() + 2 * minute),
            )

            await llmUsageRepository.purgePromptText({ olderThan: cutoff, dryRun: false })

            expect((await rowOf(before)).finalPrompt).toBe('')
            expect((await rowOf(at)).finalPrompt).toBe('')
            expect((await rowOf(after)).finalPrompt).toBe('two minutes after')
        })

        it('runs no statement after a checkpoint throws', async () => {
            const ids: bigint[] = []
            for (let i = 0; i < 5; i += 1) ids.push(await insert(`stopped prompt ${String(i)}`, 40))
            const withText = await countWithText()
            let calls = 0
            const checkpoint = (): void => {
                calls += 1
                if (calls > 1) throw new Error('stop')
            }

            await expect(
                llmUsageRepository.purgePromptText({
                    olderThan: null,
                    dryRun: false,
                    batchSize: 2,
                    checkpoint,
                }),
            ).rejects.toThrow('stop')

            // Only the first batch of 2 went.
            expect(await countWithText()).toBe(withText - 2)
        })

        it('empties every row exactly once when two runs overlap', async () => {
            for (let i = 0; i < 7; i += 1) await insert(`overlap prompt ${String(i)}`, 40)
            const withText = await countWithText()
            // Both runs are inside their first batch before either goes on.
            bothReadBeforeEitherWrites(db, 'execute')

            const [first, second] = await Promise.all([
                llmUsageRepository.purgePromptText({
                    olderThan: null,
                    dryRun: false,
                    batchSize: 2,
                }),
                llmUsageRepository.purgePromptText({
                    olderThan: null,
                    dryRun: false,
                    batchSize: 2,
                }),
            ])
            vi.restoreAllMocks()

            expect(first.changed + second.changed).toBe(withText)
            expect(await countWithText()).toBe(0)
        })

        it('counts and changes nothing on a dry run', async () => {
            const id = await insert('text to keep for now', 40)

            const result = await llmUsageRepository.purgePromptText({
                olderThan: null,
                dryRun: true,
            })

            expect(result.matched).toBeGreaterThanOrEqual(1)
            expect(result.changed).toBe(0)
            expect(result.matched).toBe(await countWithText())
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
