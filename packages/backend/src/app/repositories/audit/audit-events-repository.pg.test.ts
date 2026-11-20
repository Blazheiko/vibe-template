import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { hasPg } from '../../../test-support/pg-test-db.js'

vi.mock('#logger', () => ({
    default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

// feat-235 (Р3, Р7): the keyset pages of the audit log on a real PostgreSQL, the microsecond
// bounds of `from` and `to`, and the stamp taken after a row lock.
describe.skipIf(!hasPg)('audit events repository on PostgreSQL', async () => {
    const { db, pool } = await import('#database/db.js')
    const { auditEvents, supportKnowledgeBase } = await import('#database/schema.js')
    const { auditEventsRepository, withTransaction } = await import('#app/repositories/index.js')
    const { auditService } = await import('#app/services/audit/audit-service.js')

    const targetId = `repo-test-${String(Date.now())}`

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

    const allPages = async (pageSize: number, filters = {}) => {
        const seen: { id: bigint; occurredAt: string }[] = []
        let cursor: { occurredAt: string; id: bigint } | null = null
        for (let page = 0; page < 100; page++) {
            const rows = await auditEventsRepository.list(
                { targetId, ...filters },
                cursor,
                pageSize,
            )
            const items = rows.slice(0, pageSize)
            seen.push(...items.map((row) => ({ id: row.id, occurredAt: row.occurredAt })))
            const last = items.at(-1)
            if (rows.length <= pageSize || last === undefined) return seen
            cursor = { occurredAt: last.occurredAt, id: last.id }
        }
        throw new Error('too many pages')
    }

    beforeEach(async () => {
        await db.delete(auditEvents).where(eq(auditEvents.targetId, targetId))
    })

    afterAll(async () => {
        await db.delete(auditEvents).where(eq(auditEvents.targetId, targetId))
        await pool.end()
    })

    it('pages through events with equal occurred_at without losing or repeating one', async () => {
        await insertAt('2026-11-20 10:00:00.000002', 1)
        await insertAt('2026-11-20 10:00:00.000001', 5)
        await insertAt('2026-11-20 10:00:00.000000', 2)

        const seen = await allPages(2)
        const ids = seen.map((row) => row.id)
        expect(ids).toHaveLength(8)
        expect(new Set(ids).size).toBe(8)
        // Newest first; on equal time the larger id first.
        const sorted = [...seen].sort((a, b) =>
            a.occurredAt === b.occurredAt
                ? Number(b.id - a.id)
                : a.occurredAt < b.occurredAt
                  ? 1
                  : -1,
        )
        expect(seen).toEqual(sorted)
        expect(seen[0]?.occurredAt).toBe('2026-11-20 10:00:00.000002')
    })

    it('keeps the microseconds of occurred_at in the page and the cursor', async () => {
        await insertAt('2026-11-20 10:00:00.123456')
        const [row] = await auditEventsRepository.list({ targetId }, null, 10)
        expect(row?.occurredAt).toBe('2026-11-20 10:00:00.123456')
    })

    it('from is inclusive and to exclusive, at millisecond bounds over microsecond values', async () => {
        await insertAt('2026-11-20 10:00:00.122999')
        await insertAt('2026-11-20 10:00:00.123000')
        await insertAt('2026-11-20 10:00:00.123999')
        await insertAt('2026-11-20 10:00:00.124000')
        await insertAt('2026-11-20 10:00:00.124001')

        const inRange = await allPages(10, {
            from: new Date('2026-11-20T10:00:00.123Z'),
            to: new Date('2026-11-20T10:00:00.124Z'),
        })
        expect(inRange.map((row) => row.occurredAt)).toEqual([
            '2026-11-20 10:00:00.123999',
            '2026-11-20 10:00:00.123',
        ])
    })

    it('a stamp taken after the lock orders the changes as they were applied', async () => {
        const [article] = await db
            .insert(supportKnowledgeBase)
            .values({ title: 'stamp order', content: 'x' })
            .returning({ id: supportKnowledgeBase.id })
        if (article === undefined) throw new Error('no article')
        const lock = (tx: Parameters<Parameters<typeof withTransaction>[0]>[0]) =>
            tx
                .select({ id: supportKnowledgeBase.id })
                .from(supportKnowledgeBase)
                .where(eq(supportKnowledgeBase.id, article.id))
                .for('update')
        const nowOf = async (tx: Parameters<Parameters<typeof withTransaction>[0]>[0]) => {
            const result = await tx.execute<{ t: string }>(sql`SELECT now()::timestamp::text AS t`)
            return result.rows[0]?.t ?? ''
        }

        let releaseSecond: () => void = () => undefined
        const secondHolds = new Promise<void>((resolve) => {
            releaseSecond = resolve
        })
        let firstStarted: () => void = () => undefined
        const firstBegan = new Promise<void>((resolve) => {
            firstStarted = resolve
        })
        let secondLocked: () => void = () => undefined
        const secondHasLock = new Promise<void>((resolve) => {
            secondLocked = resolve
        })

        // The first transaction starts first but gets the lock second.
        const first = withTransaction(async (tx) => {
            const startedAt = await nowOf(tx)
            firstStarted()
            await secondHasLock
            const waiting = lock(tx)
            setTimeout(releaseSecond, 50)
            await waiting
            const stamp = await auditService.stamp(tx)
            return { startedAt, stamp: stamp.occurredAt }
        })
        await firstBegan
        await new Promise((resolve) => setTimeout(resolve, 5))
        const second = withTransaction(async (tx) => {
            const startedAt = await nowOf(tx)
            await lock(tx)
            secondLocked()
            await secondHolds
            const stamp = await auditService.stamp(tx)
            return { startedAt, stamp: stamp.occurredAt }
        })

        const [a, b] = await Promise.all([first, second])
        await db.delete(supportKnowledgeBase).where(eq(supportKnowledgeBase.id, article.id))
        // now() would put them the other way round.
        expect(a.startedAt < b.startedAt).toBe(true)
        expect(a.stamp > b.stamp).toBe(true)
    })

    it('purges in batches only what is older than the cutoff, oldest first', async () => {
        await insertAt('2026-01-01 00:00:00.000000', 3)
        await insertAt('2026-01-01 00:01:00.000000', 1)
        const cutoff = new Date('2026-01-01T00:01:00.000Z')
        expect(await auditEventsRepository.countPurgeable(cutoff)).toBeGreaterThanOrEqual(3)
        let total = 0
        for (;;) {
            const deleted = await auditEventsRepository.purgeBatch(cutoff, 2)
            total += deleted
            if (deleted < 2) break
        }
        expect(total).toBeGreaterThanOrEqual(3)
        const left = await auditEventsRepository.list({ targetId }, null, 10)
        expect(left.map((row) => row.occurredAt)).toEqual(['2026-01-01 00:01:00'])
    })
})
