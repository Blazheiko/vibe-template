import { and, eq, gte, inArray, lt, sql, type SQL } from 'drizzle-orm'
import type { InferInsertModel, InferSelectModel } from 'drizzle-orm'

import { db } from '#database/db.js'
import { auditEvents } from '#database/schema.js'
import type { DbExecutor } from '#app/repositories/transaction.js'
import type { UserId, AuditEventId } from '#app/domain/ids.js'

export type AuditEventRow = InferSelectModel<typeof auditEvents>
export type AuditEventInsert = Omit<InferInsertModel<typeof auditEvents>, 'id' | 'occurredAt'> & {
    /** `occurred_at` as PostgreSQL wrote it (`clock_timestamp()::text`), microseconds included. */
    occurredAt: string
}

/** A row of a page, with `occurred_at` as text: a JS Date would drop its microseconds (Р7). */
export interface AuditEventListRow extends Omit<AuditEventRow, 'occurredAt'> {
    occurredAt: string
}

export interface AuditEventFilters {
    actions?: readonly string[]
    actorUserId?: UserId
    targetUserId?: UserId
    targetType?: string
    targetId?: string
    requestId?: string
    /** Inclusive. */
    from?: Date
    /** Exclusive. */
    to?: Date
}

/** The position after the last row of a page: its `occurred_at` (as text) and id. */
export interface AuditEventCursor {
    occurredAt: string
    id: AuditEventId
}

const t = auditEvents

function conditionsOf(filters: AuditEventFilters, cursor: AuditEventCursor | null): SQL[] {
    const conditions: SQL[] = []
    if (filters.actions !== undefined) conditions.push(inArray(t.action, [...filters.actions]))
    if (filters.actorUserId !== undefined) conditions.push(eq(t.actorUserId, filters.actorUserId))
    if (filters.targetUserId !== undefined) {
        conditions.push(eq(t.targetUserId, filters.targetUserId))
    }
    if (filters.targetType !== undefined) conditions.push(eq(t.targetType, filters.targetType))
    if (filters.targetId !== undefined) conditions.push(eq(t.targetId, filters.targetId))
    if (filters.requestId !== undefined) conditions.push(eq(t.requestId, filters.requestId))
    if (filters.from !== undefined) conditions.push(gte(t.occurredAt, filters.from))
    if (filters.to !== undefined) conditions.push(lt(t.occurredAt, filters.to))
    if (cursor !== null) {
        conditions.push(
            sql`(${t.occurredAt}, ${t.id}) < (${cursor.occurredAt}::timestamp, ${cursor.id}::bigint)`,
        )
    }
    return conditions
}

/**
 * The batch DELETE of the retention job (Р9), exported for its EXPLAIN test. `ORDER BY
 * occurred_at` reads audit_events_occurred_at_idx backwards: the batch costs `limit` entries.
 */
export function auditEventsPurgeBatch(cutoff: Date, limit: number): SQL {
    return sql`DELETE FROM ${t} WHERE ${t.id} = ANY(ARRAY(
        SELECT ${t.id} FROM ${t}
        WHERE ${t.occurredAt} < ${cutoff.toISOString()}::timestamp
        ORDER BY ${t.occurredAt}
        LIMIT ${limit}
    )) RETURNING ${t.id}`
}

// feat-235 (Р2): the log has no update. The only writes are the insert of the events of one change
// and the retention job's delete; layering.spec.ts keeps it that way.
export const auditEventsRepository = {
    /** The events of one change, in one statement of the change's transaction. */
    async insert(entries: readonly AuditEventInsert[], executor: DbExecutor): Promise<void> {
        if (entries.length === 0) return
        await executor.insert(t).values(
            entries.map((entry) => ({
                ...entry,
                // The stamp is text; the column parses it, so the microseconds stay.
                occurredAt: sql`${entry.occurredAt}::timestamp`,
            })),
        )
    },

    /**
     * One page, newest first: `limit + 1` rows are read, so the caller knows whether there is a
     * next page without a COUNT.
     */
    async list(
        filters: AuditEventFilters,
        cursor: AuditEventCursor | null,
        limit: number,
    ): Promise<AuditEventListRow[]> {
        const conditions = conditionsOf(filters, cursor)
        return db
            .select({
                id: t.id,
                occurredAt: sql<string>`${t.occurredAt}::text`,
                actorKind: t.actorKind,
                actorUserId: t.actorUserId,
                actorRole: t.actorRole,
                action: t.action,
                targetType: t.targetType,
                targetId: t.targetId,
                targetUserId: t.targetUserId,
                requestId: t.requestId,
                changes: t.changes,
                metadata: t.metadata,
            })
            .from(t)
            .where(conditions.length === 0 ? undefined : and(...conditions))
            .orderBy(sql`${t.occurredAt} DESC, ${t.id} DESC`)
            .limit(limit + 1)
    },

    /**
     * Deletes up to `limit` of the oldest events before `cutoff` in one statement (Р9): no read
     * followed by a write, so two runs at once delete every row exactly once.
     *
     * @returns how many rows this statement deleted
     */
    async purgeBatch(
        cutoff: Date,
        limit: number,
        executor: Pick<typeof db, 'execute'> = db,
    ): Promise<number> {
        const result = await executor.execute<{ id: string }>(auditEventsPurgeBatch(cutoff, limit))
        return result.rows.length
    },

    /** The events a purge with this cutoff would delete (the dry run of the retention job). */
    async countPurgeable(cutoff: Date): Promise<number> {
        const [row] = await db
            .select({ count: sql<number>`count(*)::int` })
            .from(t)
            .where(sql`${t.occurredAt} < ${cutoff.toISOString()}::timestamp`)
        return row?.count ?? 0
    },
}
