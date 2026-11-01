import { db } from '#database/db.js'
import { supportChatHistory } from '#database/schema.js'
import { eq, desc } from 'drizzle-orm'
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

    async findChatHistory(userId: bigint, limit?: number): Promise<SupportChatRow[]> {
        const query = db
            .select()
            .from(supportChatHistory)
            .where(eq(supportChatHistory.userId, userId))
            .orderBy(desc(supportChatHistory.createdAt))

        const rows = limit !== undefined ? await query.limit(limit) : await query

        return rows.reverse()
    },

    async deleteAllChatHistory(userId: bigint): Promise<number> {
        const deleted = await db
            .delete(supportChatHistory)
            .where(eq(supportChatHistory.userId, userId))
            .returning()
        return deleted.length
    },
}
