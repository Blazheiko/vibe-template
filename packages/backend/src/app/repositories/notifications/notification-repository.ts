import { and, desc, eq, isNull, lt, lte, sql, type SQL } from 'drizzle-orm'
import type { InferSelectModel } from 'drizzle-orm'

import { db } from '#database/db.js'
import { notifications } from '#database/schema.js'
import { NOTIFICATIONS_UNREAD_COUNT_CAP } from 'shared/notifications'
import type { UserId } from '#app/domain/ids.js'

export type NotificationRow = InferSelectModel<typeof notifications>

export interface NotificationInsert {
    userId: UserId
    category: string
    kind: string
    params: Record<string, unknown>
    link: string | null
}

export interface NotificationPage {
    rows: NotificationRow[]
    /** The id to pass as `before` for the next page, or null when this one was the last. */
    next: bigint | null
}

const t = notifications

/**
 * One batch of the retention job (Р10): the oldest rows past the cutoff, read and deleted in one
 * statement. `ORDER BY created_at` reads notifications_created_at_idx.
 */
export function notificationsPurgeBatch(cutoff: Date, limit: number): SQL {
    return sql`DELETE FROM ${t} WHERE ${t.id} = ANY(ARRAY(
        SELECT ${t.id} FROM ${t}
        WHERE ${t.createdAt} < ${cutoff.toISOString()}::timestamp
        ORDER BY ${t.createdAt}
        LIMIT ${limit}
    )) RETURNING ${t.id}`
}

// feat-236 (Р1, Р6): every read and write but the retention purge is bound to one user: a
// notification of another user is never read, changed or counted.
export const notificationRepository = {
    async insert(entry: NotificationInsert): Promise<bigint> {
        const [row] = await db.insert(t).values(entry).returning({ id: t.id })
        if (row === undefined) throw new Error('notification not inserted')
        return row.id
    },

    /** Newest first, `id < before`. Reads one row more than `limit` to know whether more follow. */
    async page(
        userId: UserId,
        options: { unread: boolean; before: bigint | null; limit: number },
    ): Promise<NotificationPage> {
        const conditions: SQL[] = [eq(t.userId, userId)]
        if (options.unread) conditions.push(isNull(t.readAt))
        if (options.before !== null) conditions.push(lt(t.id, options.before))
        const rows = await db
            .select()
            .from(t)
            .where(and(...conditions))
            .orderBy(desc(t.id))
            .limit(options.limit + 1)
        const page = rows.slice(0, options.limit)
        const last = page.at(-1)
        return {
            rows: page,
            next: rows.length > options.limit && last !== undefined ? last.id : null,
        }
    },

    /**
     * The unread count, capped (Р6): the LIMIT is on the rows of the subquery, before COUNT, so at
     * most the cap of rows of the partial index is read.
     */
    async countUnread(userId: UserId): Promise<number> {
        const result = await db.execute<{ count: number }>(sql`
            SELECT COUNT(*)::int AS count FROM (
                SELECT 1 FROM ${t}
                WHERE ${t.userId} = ${userId} AND ${t.readAt} IS NULL
                LIMIT ${NOTIFICATIONS_UNREAD_COUNT_CAP}
            ) AS unread`)
        return result.rows[0]?.count ?? 0
    },

    /**
     * Marks one notification of the user read and answers its link (Р6). Idempotent: one read
     * already keeps its `read_at` and answers the same link. Null: no such notification of this
     * user. Both statements are bound to the user.
     */
    async markRead(userId: UserId, id: bigint): Promise<{ link: string | null } | null> {
        await db
            .update(t)
            .set({ readAt: sql`now()` })
            .where(and(eq(t.id, id), eq(t.userId, userId), isNull(t.readAt)))
        const [row] = await db
            .select({ link: t.link })
            .from(t)
            .where(and(eq(t.id, id), eq(t.userId, userId)))
        return row === undefined ? null : { link: row.link }
    },

    /** Marks every unread notification of the user with `id <= upTo` read (Р6). */
    async markAllUpTo(userId: UserId, upTo: bigint): Promise<number> {
        const rows = await db
            .update(t)
            .set({ readAt: sql`now()` })
            .where(and(eq(t.userId, userId), lte(t.id, upTo), isNull(t.readAt)))
            .returning({ id: t.id })
        return rows.length
    },

    /** One retention batch; the number of rows deleted. */
    async purgeBatch(
        cutoff: Date,
        limit: number,
        executor: Pick<typeof db, 'execute'> = db,
    ): Promise<number> {
        const result = await executor.execute<{ id: string }>(
            notificationsPurgeBatch(cutoff, limit),
        )
        return result.rows.length
    },

    /** The rows a purge with this cutoff would delete (the dry run of the retention job). */
    async countPurgeable(cutoff: Date): Promise<number> {
        const [row] = await db
            .select({ count: sql<number>`count(*)::int` })
            .from(t)
            .where(sql`${t.createdAt} < ${cutoff.toISOString()}::timestamp`)
        return row?.count ?? 0
    },
}
