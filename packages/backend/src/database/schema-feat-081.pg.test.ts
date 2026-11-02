import { eq, sql } from 'drizzle-orm'
import { afterAll, describe, expect, it, vi } from 'vitest'

import { hasPg } from '../test-support/pg-test-db.js'

vi.mock('#logger', () => ({
    default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

// feat-081 (phase M): the usage log outlives the account (owner decision), and the history of
// a support chat is indexed by (user_id, created_at).
describe.skipIf(!hasPg)('schema: llm_text_usage and support_chat_history', async () => {
    const { db, pool } = await import('#database/db.js')
    const { llmTextUsage, users, supportChatHistory } = await import('#database/schema.js')
    const model = `schema-081-${String(Date.now())}`

    afterAll(async () => {
        await db.delete(llmTextUsage).where(eq(llmTextUsage.model, model))
        await pool.end()
    })

    it('keeps the usage rows of a deleted user, without the link to them', async () => {
        const [user] = await db
            .insert(users)
            .values({ name: 'gone', email: `gone-${String(Date.now())}@example.test` })
            .returning({ id: users.id })
        const userId = user?.id ?? 0n
        await db.insert(llmTextUsage).values({
            userId,
            model,
            feature: 'SUPPORT_CHAT',
            finalPrompt: '',
            promptTokens: 4,
            completionTokens: 6,
            totalTokens: 10,
        })

        await db.delete(users).where(eq(users.id, userId))

        const rows = await db.select().from(llmTextUsage).where(eq(llmTextUsage.model, model))
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({ userId: null, totalTokens: 10 })
    })

    it('still deletes the chat history of a deleted user (that one is personal content)', async () => {
        const [user] = await db
            .insert(users)
            .values({ name: 'gone2', email: `gone2-${String(Date.now())}@example.test` })
            .returning({ id: users.id })
        const userId = user?.id ?? 0n
        await db.insert(supportChatHistory).values({ userId, role: 'user', content: 'hello' })

        await db.delete(users).where(eq(users.id, userId))

        const rows = await db
            .select()
            .from(supportChatHistory)
            .where(eq(supportChatHistory.userId, userId))
        expect(rows).toHaveLength(0)
    })

    it('indexes support_chat_history by (user_id, created_at), and no longer by user_id alone', async () => {
        const result = await db.execute<{ indexname: string; indexdef: string }>(
            sql`SELECT indexname, indexdef FROM pg_indexes
                WHERE tablename = 'support_chat_history' ORDER BY indexname`,
        )
        const names = result.rows.map((row) => row.indexname)
        expect(names).toContain('support_chat_history_user_created_idx')
        expect(names).not.toContain('support_chat_history_user_idx')
        const created = result.rows.find(
            (row) => row.indexname === 'support_chat_history_user_created_idx',
        )
        expect(created?.indexdef).toContain('(user_id, created_at)')
    })
})
