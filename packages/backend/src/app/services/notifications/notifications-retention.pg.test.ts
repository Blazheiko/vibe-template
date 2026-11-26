import { eq, inArray, sql } from 'drizzle-orm'
import type { NormalizedEmail } from '#app/domain/email.js'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { hasPg } from '../../../test-support/pg-test-db.js'
import { bothReadBeforeEitherWrites } from '../../../test-support/race-barrier.js'

vi.mock('#logger', () => ({
    default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

// feat-236 (Р10) on a real PostgreSQL, by the requirements of "Adding a job"
// (documentation/backend/scheduler.md). The rows are stamped in 2001, so the notifications other
// test files write (stamped now) never qualify.

describe.skipIf(!hasPg)('notifications-retention on PostgreSQL', async () => {
    const { db, pool } = await import('#database/db.js')
    const { users, notifications } = await import('#database/schema.js')
    const { notificationRepository, withTransaction } = await import('#app/repositories/index.js')
    const { notificationsPurgeBatch } =
        await import('#app/repositories/notifications/notification-repository.js')
    const { notificationsRetentionService } =
        await import('#app/services/notifications/notifications-retention-service.js')

    const CUTOFF = new Date('2001-06-01T12:00:00.000Z')
    const [owner] = await db
        .insert(users)
        .values({
            name: 'retention-test',
            email: `${crypto.randomUUID()}@example.test` as NormalizedEmail,
        })
        .returning({ id: users.id })
    if (owner === undefined) throw new Error('user not inserted')
    const userId = owner.id

    const insertAt = async (createdAt: string, count = 1, read = false): Promise<void> => {
        await db.insert(notifications).values(
            Array.from({ length: count }, () => ({
                userId,
                category: 'security',
                kind: 'security.logout_all',
                params: {},
                link: '/account',
                createdAt: sql`${createdAt}::timestamp`,
                readAt: read ? sql`${createdAt}::timestamp` : null,
            })),
        )
    }
    const left = async (): Promise<string[]> => {
        const rows = await db
            .select({ at: sql<string>`${notifications.createdAt}::text` })
            .from(notifications)
            .where(eq(notifications.userId, userId))
            .orderBy(notifications.createdAt)
        return rows.map((row) => row.at)
    }

    beforeEach(async () => {
        await db.delete(notifications).where(eq(notifications.userId, userId))
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    afterAll(async () => {
        await db.delete(users).where(inArray(users.id, [userId]))
        await pool.end()
    })

    it('deletes only what is older than the cut-off, strictly, minutes on either side', async () => {
        await insertAt('2001-06-01 11:58:00')
        await insertAt('2001-06-01 11:59:59.999999')
        await insertAt('2001-06-01 12:00:00')
        await insertAt('2001-06-01 12:02:00')

        const counts = await notificationsRetentionService.purge({ before: CUTOFF, dryRun: false })

        expect(counts).toEqual({ matched: 2, changed: 2 })
        expect(await left()).toEqual(['2001-06-01 12:00:00', '2001-06-01 12:02:00'])
    })

    it('deletes read and unread notifications alike', async () => {
        await insertAt('2001-01-01 00:00:00', 2, true)
        await insertAt('2001-01-01 00:00:00', 3, false)

        const counts = await notificationsRetentionService.purge({ before: CUTOFF, dryRun: false })

        expect(counts).toEqual({ matched: 5, changed: 5 })
        expect(await left()).toEqual([])
    })

    it('loops over small batches until one comes back short', async () => {
        await insertAt('2001-01-01 00:00:00', 7)
        const purge = vi.spyOn(notificationRepository, 'purgeBatch')

        const counts = await notificationsRetentionService.purge({
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
        const purge = vi.spyOn(notificationRepository, 'purgeBatch')
        let calls = 0
        const checkpoint = () => {
            calls += 1
            if (calls > 1) throw new Error('aborted')
        }

        await expect(
            notificationsRetentionService.purge({
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

        const dry = await notificationsRetentionService.purge({ before: CUTOFF, dryRun: true })
        expect(await left()).toHaveLength(5)
        const real = await notificationsRetentionService.purge({ before: CUTOFF, dryRun: false })

        expect(dry).toEqual({ matched: 4, changed: 0 })
        expect(real).toEqual({ matched: 4, changed: 4 })
    })

    it('two overlapping runs delete every row exactly once', async () => {
        await insertAt('2001-01-01 00:00:00', 6)
        bothReadBeforeEitherWrites(notificationRepository, 'countPurgeable')
        const run = async () => {
            await notificationRepository.countPurgeable(CUTOFF)
            return notificationsRetentionService.purge({ before: CUTOFF, dryRun: false })
        }

        const [a, b] = await Promise.all([run(), run()])

        expect(a.changed + b.changed).toBe(6)
        expect(await left()).toEqual([])
    })

    it('reads the batch from the created_at index, without a sort', async () => {
        const plan = await withTransaction(async (tx) => {
            await tx.execute(sql`SET LOCAL enable_seqscan = off`)
            await tx.execute(sql`SET LOCAL enable_sort = off`)
            const result = await tx.execute<{ 'QUERY PLAN': string }>(
                sql`EXPLAIN ${notificationsPurgeBatch(CUTOFF, 1000)}`,
            )
            return result.rows.map((row) => row['QUERY PLAN']).join('\n')
        })
        expect(plan).toMatch(/notifications_created_at_idx/)
        expect(plan).not.toMatch(/Sort/)
    })
})
