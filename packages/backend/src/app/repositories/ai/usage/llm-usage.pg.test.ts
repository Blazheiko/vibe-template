import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { hasPg } from '../../../../test-support/pg-test-db.js'

vi.mock('#logger', () => ({
    default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

// feat-028 (code-issues item 53): NULL tokens mean "provider did not report
// usage", system calls have no user, embeddings get their own feature.
describe.skipIf(!hasPg)('llm_text_usage on PostgreSQL', async () => {
    const { db, pool } = await import('#database/db.js')
    const { llmTextUsage, users } = await import('#database/schema.js')
    const { llmUsageRepository } = await import('#app/repositories/index.js')
    const model = `usage-test-${String(Date.now())}`
    let userId = 0n

    beforeAll(async () => {
        const [user] = await db
            .insert(users)
            .values({ name: 'usage', email: `usage-${String(Date.now())}@example.test` })
            .returning({ id: users.id })
        userId = user?.id ?? 0n
        const base = { model, finalPrompt: 'p', createdAt: new Date() }
        await llmUsageRepository.insertText({
            ...base,
            userId,
            feature: 'SUPPORT_CHAT',
            promptTokens: 10,
            completionTokens: 5,
            totalTokens: 15,
        })
        await llmUsageRepository.insertText({
            ...base,
            userId,
            feature: 'SUPPORT_CHAT',
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
        })
        // Provider without usage: NULL, not 0.
        await llmUsageRepository.insertText({
            ...base,
            userId,
            feature: 'SUPPORT_CHAT',
            promptTokens: null,
            completionTokens: null,
            totalTokens: null,
        })
        // Knowledge-base indexing: no user, own feature.
        await llmUsageRepository.insertText({
            ...base,
            userId: null,
            feature: 'SUPPORT_EMBEDDING',
            promptTokens: 7,
            completionTokens: null,
            totalTokens: 7,
        })
    })

    afterAll(async () => {
        await db.delete(llmTextUsage).where(eq(llmTextUsage.model, model))
        await db.delete(users).where(eq(users.id, userId))
        await pool.end()
    })

    it('stores NULL tokens and a NULL user as written', async () => {
        const rows = await db
            .select()
            .from(llmTextUsage)
            .where(eq(llmTextUsage.model, model))
            .orderBy(llmTextUsage.id)
        expect(rows.map((row) => row.totalTokens)).toEqual([15, 0, null, 7])
        expect(rows[3]).toMatchObject({ userId: null, feature: 'SUPPORT_EMBEDDING' })
    })

    it('has no column defaults left for the token counters', async () => {
        const result = await db.execute<{ column_name: string; column_default: string | null }>(
            sql`SELECT column_name, column_default FROM information_schema.columns
                WHERE table_name = 'llm_text_usage'
                  AND column_name IN ('prompt_tokens', 'completion_tokens', 'total_tokens')`,
        )
        expect(result.rows.map((row) => row.column_default)).toEqual([null, null, null])
    })

    it('stats: sum ignores NULL, calls without usage are counted separately', async () => {
        const stats = (await llmUsageRepository.getTextStats()).filter((row) => row.model === model)
        const chat = stats.find((row) => row.feature === 'SUPPORT_CHAT')
        const embedding = stats.find((row) => row.feature === 'SUPPORT_EMBEDDING')
        expect(chat).toEqual({
            model,
            feature: 'SUPPORT_CHAT',
            totalCalls: 3,
            totalTokens: 15,
            // feat-118: these rows have reported usage or NULL (no estimate), and all completed.
            estimatedTokens: 0,
            callsWithoutUsage: 1,
            abortedCalls: 0,
            failedCalls: 0,
        })
        expect(embedding).toMatchObject({ totalCalls: 1, totalTokens: 7, callsWithoutUsage: 0 })
    })
    // feat-044: PostgreSQL returns count(*) as a bigint string; the
    // GetTextUsageResponseSchema total is a number.
    it('countText returns a number, not a bigint string', async () => {
        const total = await llmUsageRepository.countText({ userId })
        expect(total).toBe(3)
    })
})
