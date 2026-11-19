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

        // feat-224: the batch walks the partial index of the rows that still hold text, in
        // (created_at, id) order from a keyset cursor, so a statement reads at most n entries
        // (feat-130 paged the whole table by id for the same bound). The tables are small and not
        // analysed here, so a sequential scan and a (incremental) sort are switched off: the
        // statement must then be able to read its batch from that index in index order.
        const cutoffs = [
            ['a cut-off', new Date(Date.now() - 30 * DAY)],
            ['no cut-off', null],
        ] as const
        const cursors = [
            ['first batch', null],
            ['after a cursor', { createdAt: '2001-01-01 00:00:00.123456', id: '42' }],
        ] as const
        it.each(
            cutoffs.flatMap(([c, olderThan]) =>
                cursors.flatMap(([k, cursor]) =>
                    [true, false].map(
                        (dryRun) =>
                            [
                                `${c}, ${k}, dryRun ${String(dryRun)}`,
                                olderThan,
                                cursor,
                                dryRun,
                            ] as const,
                    ),
                ),
            ),
        )(
            'reads its batch from the partial index in index order (%s)',
            async (_name, olderThan, cursor, dryRun) => {
                const plan = await db.transaction(async (tx) => {
                    await tx.execute(sql`SET LOCAL enable_seqscan = off`)
                    await tx.execute(sql`SET LOCAL enable_sort = off`)
                    await tx.execute(sql`SET LOCAL enable_incremental_sort = off`)
                    const result = await tx.execute<{ 'QUERY PLAN': string }>(
                        sql`EXPLAIN ${promptPurgeBatch(olderThan, cursor, 1000, dryRun)}`,
                    )
                    return result.rows.map((row) => row['QUERY PLAN']).join('\n')
                })
                // The batch is a Limit straight over the index: no sort of the rows that hold text.
                expect(plan).toMatch(
                    /CTE batch\n\s+->\s+Limit[^\n]*\n\s+->\s+Index (Only )?Scan using llm_text_usage_prompt_text_created_at_idx/,
                )
            },
        )

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

        // T21: the job itself on the real table, with the real service.
        it('the llm-prompt-retention job empties the text past the retention and keeps the rest', async () => {
            const { createLlmPromptRetentionJob } =
                await import('#app/scheduler/jobs/llm-prompt-retention.js')
            const { llmUsageService } = await import('#app/services/ai/usage/llm-usage-service.js')
            const old = await insert('prompt past the retention', 40)
            const recent = await insert('prompt within the retention', 1)
            const job = createLlmPromptRetentionJob({
                usage: { storePrompts: true, retentionDays: 30 },
                configError: null,
                now: Date.now,
                purge: (options) => llmUsageService.purgePromptText(options),
            })
            const checkpoint = vi.fn()

            const result = await job.run({
                signal: new AbortController().signal,
                checkpoint,
                slot: Date.now(),
                dryRun: false,
                logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
            })

            expect(result.changed).toBeGreaterThanOrEqual(1)
            expect(checkpoint).toHaveBeenCalled()
            expect((await rowOf(old)).finalPrompt).toBe('')
            expect((await rowOf(old)).promptSha256).toBe(sha256('prompt past the retention'))
            expect((await rowOf(recent)).finalPrompt).toBe('prompt within the retention')
        })

        // The cursor keeps microseconds and breaks ties by id: a dry run in batches of 2 over rows
        // that share one created_at with microseconds counts each row once.
        it('counts every row once in batches, through equal timestamps with microseconds', async () => {
            const ids: bigint[] = []
            for (let i = 0; i < 5; i += 1) ids.push(await insert(`tie ${String(i)}`, 40))
            await db.execute(
                sql`update ${llmTextUsage} set ${sql.identifier('created_at')} = '2001-02-03 04:05:06.123456'::timestamp where ${inArray(llmTextUsage.id, ids)}`,
            )
            const withText = await countWithText()

            const dry = await llmUsageRepository.purgePromptText({
                olderThan: null,
                dryRun: true,
                batchSize: 2,
            })

            expect(dry).toEqual({ matched: withText, changed: 0 })
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
