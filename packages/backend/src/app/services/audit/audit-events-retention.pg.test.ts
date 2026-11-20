import { eq, sql } from 'drizzle-orm'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { hasPg } from '../../../test-support/pg-test-db.js'
import { bothReadBeforeEitherWrites } from '../../../test-support/race-barrier.js'

vi.mock('#logger', () => ({
    default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

// feat-235 (Р9) on a real PostgreSQL, by the requirements of "Adding a job"
// (documentation/backend/scheduler.md). The rows are stamped in 2001, so the events other test
// files write (stamped now) never qualify.

describe.skipIf(!hasPg)('audit-events-retention on PostgreSQL', async () => {
    const { db, pool } = await import('#database/db.js')
    const { auditEvents } = await import('#database/schema.js')
    const { auditEventsRepository, withTransaction } = await import('#app/repositories/index.js')
    const { auditEventsPurgeBatch } =
        await import('#app/repositories/audit/audit-events-repository.js')
    const { auditEventsRetentionService } =
        await import('#app/services/audit/audit-events-retention-service.js')

    const CUTOFF = new Date('2001-06-01T12:00:00.000Z')
    const targetId = `retention-${String(Date.now())}`

    const insertAt = async (occurredAt: string, count = 1): Promise<void> => {
        await auditEventsRepository.insert(
            Array.from({ length: count }, () => ({
                occurredAt,
                actorKind: 'system' as const,
                action: 'user.admin.created',
                targetType: 'user',
                targetId,
                metadata: { source: 'seed' },
            })),
            db,
        )
    }
    const left = async (): Promise<string[]> => {
        const rows = await db
            .select({ at: sql<string>`${auditEvents.occurredAt}::text` })
            .from(auditEvents)
            .where(eq(auditEvents.targetId, targetId))
            .orderBy(auditEvents.occurredAt)
        return rows.map((row) => row.at)
    }

    beforeEach(async () => {
        await db.delete(auditEvents).where(eq(auditEvents.targetId, targetId))
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    afterAll(async () => {
        await db.delete(auditEvents).where(eq(auditEvents.targetId, targetId))
        await pool.end()
    })

    it('deletes only what is older than the cut-off, strictly, minutes on either side', async () => {
        await insertAt('2001-06-01 11:58:00')
        await insertAt('2001-06-01 11:59:59.999999')
        await insertAt('2001-06-01 12:00:00')
        await insertAt('2001-06-01 12:02:00')

        const counts = await auditEventsRetentionService.purge({ before: CUTOFF, dryRun: false })

        expect(counts).toEqual({ matched: 2, changed: 2 })
        expect(await left()).toEqual(['2001-06-01 12:00:00', '2001-06-01 12:02:00'])
    })

    it('loops over small batches until one comes back short', async () => {
        await insertAt('2001-01-01 00:00:00', 7)
        const purge = vi.spyOn(auditEventsRepository, 'purgeBatch')

        const counts = await auditEventsRetentionService.purge({
            before: CUTOFF,
            dryRun: false,
            batchSize: 3,
        })

        expect(counts).toEqual({ matched: 7, changed: 7 })
        expect(purge).toHaveBeenCalledTimes(3)
        expect(await left()).toEqual([])
    })

    it('a checkpoint that throws after the first batch stops before the next query', async () => {
        await insertAt('2001-01-01 00:00:00', 5)
        const purge = vi.spyOn(auditEventsRepository, 'purgeBatch')
        let calls = 0
        const checkpoint = () => {
            calls += 1
            if (calls > 1) throw new Error('aborted')
        }

        await expect(
            auditEventsRetentionService.purge({
                before: CUTOFF,
                dryRun: false,
                batchSize: 2,
                checkpoint,
            }),
        ).rejects.toThrow('aborted')

        expect(purge).toHaveBeenCalledTimes(1)
        expect(await left()).toHaveLength(3)
    })

    it('a dry run counts the same rows and deletes nothing', async () => {
        await insertAt('2001-01-01 00:00:00', 4)
        await insertAt('2001-06-01 12:00:00')

        const dry = await auditEventsRetentionService.purge({ before: CUTOFF, dryRun: true })
        expect(await left()).toHaveLength(5)
        const real = await auditEventsRetentionService.purge({ before: CUTOFF, dryRun: false })

        expect(dry).toEqual({ matched: 4, changed: 0 })
        expect(real).toEqual({ matched: 4, changed: 4 })
    })

    it('two overlapping runs delete every row exactly once', async () => {
        await insertAt('2001-01-01 00:00:00', 6)
        bothReadBeforeEitherWrites(auditEventsRepository, 'countPurgeable')
        // Both runs pass their dry-run count, then both delete the same batch at once.
        const run = async () => {
            await auditEventsRepository.countPurgeable(CUTOFF)
            return auditEventsRetentionService.purge({ before: CUTOFF, dryRun: false })
        }

        const [a, b] = await Promise.all([run(), run()])

        expect(a.changed + b.changed).toBe(6)
        expect(await left()).toEqual([])
    })

    it('reads the batch from the index, without a sort', async () => {
        const plan = await withTransaction(async (tx) => {
            await tx.execute(sql`SET LOCAL enable_seqscan = off`)
            await tx.execute(sql`SET LOCAL enable_sort = off`)
            const result = await tx.execute<{ 'QUERY PLAN': string }>(
                sql`EXPLAIN ${auditEventsPurgeBatch(CUTOFF, 1000)}`,
            )
            return result.rows.map((row) => row['QUERY PLAN']).join('\n')
        })
        expect(plan).toMatch(/audit_events_occurred_at_idx/)
        expect(plan).not.toMatch(/Sort/)
    })

    it('the trigger lets the DELETE through', async () => {
        await insertAt('2001-01-01 00:00:00')
        await expect(auditEventsRepository.purgeBatch(CUTOFF, 10)).resolves.toBe(1)
    })
})
