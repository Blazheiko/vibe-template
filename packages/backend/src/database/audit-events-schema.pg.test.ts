import { eq, sql } from 'drizzle-orm'
import { afterAll, describe, expect, it, vi } from 'vitest'

import { hasPg } from '../test-support/pg-test-db.js'

vi.mock('#logger', () => ({
    default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

// feat-235 (Р1, Р2): the migration creates audit_events append-only. An UPDATE is refused by the
// trigger, a DELETE (the retention job) passes, and a row without occurred_at is refused: there
// is no default to fall back to.
describe.skipIf(!hasPg)('audit_events schema on PostgreSQL', async () => {
    const { db, pool } = await import('#database/db.js')
    const { auditEvents } = await import('#database/schema.js')

    const targetId = `schema-test-${String(Date.now())}`

    afterAll(async () => {
        await db.delete(auditEvents).where(eq(auditEvents.targetId, targetId))
        await pool.end()
    })

    const insertRow = async (): Promise<bigint> => {
        const [row] = await db
            .insert(auditEvents)
            .values({
                occurredAt: new Date(),
                actorKind: 'system',
                action: 'user.admin.created',
                targetType: 'user',
                targetId,
                metadata: { source: 'seed' },
            })
            .returning({ id: auditEvents.id })
        if (row === undefined) throw new Error('not inserted')
        return row.id
    }

    it('refuses an UPDATE of a row with the trigger error', async () => {
        const id = await insertRow()
        await expect(
            db.update(auditEvents).set({ action: 'changed' }).where(eq(auditEvents.id, id)),
        ).rejects.toMatchObject({
            cause: expect.objectContaining({
                message: expect.stringContaining('audit_events rows cannot be updated'),
            }),
        })
        const [row] = await db.select().from(auditEvents).where(eq(auditEvents.id, id))
        expect(row?.action).toBe('user.admin.created')
    })

    it('lets a DELETE through', async () => {
        const id = await insertRow()
        const deleted = await db
            .delete(auditEvents)
            .where(eq(auditEvents.id, id))
            .returning({ id: auditEvents.id })
        expect(deleted).toEqual([{ id }])
    })

    it('refuses a row without occurred_at', async () => {
        await expect(
            db.execute(
                sql`INSERT INTO audit_events (actor_kind, action, target_type, target_id)
                    VALUES ('system', 'user.admin.created', 'user', ${targetId})`,
            ),
        ).rejects.toMatchObject({
            cause: expect.objectContaining({ code: '23502' }),
        })
    })

    it('stores microseconds in occurred_at', async () => {
        const result = await db.execute<{ t: string }>(
            sql`SELECT '2026-11-20 10:00:00.123456'::timestamp(6)::text AS t`,
        )
        expect(result.rows[0]?.t).toBe('2026-11-20 10:00:00.123456')
        const columns = await db.execute<{ datetime_precision: number }>(
            sql`SELECT datetime_precision FROM information_schema.columns
                WHERE table_name = 'audit_events' AND column_name = 'occurred_at'`,
        )
        expect(columns.rows[0]?.datetime_precision).toBe(6)
    })
})
