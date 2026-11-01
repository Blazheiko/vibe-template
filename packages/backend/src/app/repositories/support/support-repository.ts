import { db } from '#database/db.js'
import { supportChatHistory } from '#database/schema.js'
import { and, desc, eq, lt } from 'drizzle-orm'
import type { InferSelectModel } from 'drizzle-orm'

export type SupportChatRow = InferSelectModel<typeof supportChatHistory>

export const supportRepository = {
    async addChatMessage(
        userId: bigint,
        role: 'user' | 'assistant',
        content: string,
        screenshots?: string[],
    ): Promise<SupportChatRow> {
        const [created] = await db
            .insert(supportChatHistory)
            .values({
                userId,
                role,
                content,
                screenshots:
                    screenshots !== undefined && screenshots.length > 0 ? screenshots : null,
            })
            .returning()
        if (created === undefined) {
            throw new Error('Failed to create support chat message')
        }
        return created
    },

    /**
     * Stores a user message once per client message id. A resend after a lost answer carries
     * the same id: the unique index (user, id) makes the second insert a no-op, even when it
     * races the first (it waits for the first transaction, then conflicts). `stored: false`
     * means the message was already there. Without an id every call stores a new row.
     */
    async addUserMessageOnce(
        userId: bigint,
        content: string,
        clientMessageId: string | undefined,
    ): Promise<{ stored: boolean }> {
        const inserted = await db
            .insert(supportChatHistory)
            .values({ userId, role: 'user', content, clientMessageId: clientMessageId ?? null })
            .onConflictDoNothing({
                target: [supportChatHistory.userId, supportChatHistory.clientMessageId],
            })
            .returning({ id: supportChatHistory.id })
        return { stored: inserted.length > 0 }
    },

    /**
     * One page of the history for the UI: the `limit` messages just before `before` (the id
     * of the oldest message the client has; without it, the latest ones), oldest-first.
     * `hasMore` is true when older messages exist. Ordered by id, not by `created_at`:
     * rows inserted in the same millisecond share a timestamp, an id is unique and increasing.
     */
    async findChatHistoryPage(
        userId: bigint,
        options: { before?: bigint | undefined; limit: number },
    ): Promise<{ rows: SupportChatRow[]; hasMore: boolean }> {
        const where =
            options.before === undefined
                ? eq(supportChatHistory.userId, userId)
                : and(
                      eq(supportChatHistory.userId, userId),
                      lt(supportChatHistory.id, options.before),
                  )
        // One more than asked for tells whether there is an older page.
        const rows = await db
            .select()
            .from(supportChatHistory)
            .where(where)
            .orderBy(desc(supportChatHistory.id))
            .limit(options.limit + 1)

        const hasMore = rows.length > options.limit
        return { rows: rows.slice(0, options.limit).reverse(), hasMore }
    },

    /** The last `limit` messages, oldest-first: the conversation the model is shown. */
    async findRecentForContext(userId: bigint, limit: number): Promise<SupportChatRow[]> {
        const rows = await db
            .select()
            .from(supportChatHistory)
            .where(eq(supportChatHistory.userId, userId))
            .orderBy(desc(supportChatHistory.id))
            .limit(limit)
        return rows.reverse()
    },

    async hasChatHistory(userId: bigint): Promise<boolean> {
        const [row] = await db
            .select({ id: supportChatHistory.id })
            .from(supportChatHistory)
            .where(eq(supportChatHistory.userId, userId))
            .limit(1)
        return row !== undefined
    },

    async deleteAllChatHistory(userId: bigint): Promise<number> {
        const deleted = await db
            .delete(supportChatHistory)
            .where(eq(supportChatHistory.userId, userId))
            .returning()
        return deleted.length
    },
}
