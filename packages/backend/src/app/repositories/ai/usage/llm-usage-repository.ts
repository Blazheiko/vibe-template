import { db } from '#database/db.js'
import { llmTextUsage } from '#database/schema.js'
import { eq, sql, desc, and, gte, inArray, lte } from 'drizzle-orm'
import type { InferInsertModel, InferSelectModel, SQL } from 'drizzle-orm'

export type LlmTextUsageRow = InferSelectModel<typeof llmTextUsage>
export type LlmTextUsageInsert = InferInsertModel<typeof llmTextUsage>

export type TextFeature = LlmTextUsageRow['feature']

export interface TextStatRow {
    model: string
    feature: string
    totalCalls: number
    /** Sum of the tokens the provider reported; NULL tokens are not counted as 0. */
    totalTokens: number
    /** Sum of the estimated tokens of calls the provider reported no usage for (feat-118). */
    estimatedTokens: number
    /** Calls without reported usage: estimated (feat-118) or NULL (rows written before). */
    callsWithoutUsage: number
    /** Calls cut off by the caller, and calls that failed or timed out (feat-118). */
    abortedCalls: number
    failedCalls: number
}

export interface TextFilter {
    userId?: bigint
    dateFrom?: Date
    dateTo?: Date
    feature?: TextFeature
}

export interface ILlmUsageRepository {
    insertText(data: LlmTextUsageInsert): Promise<void>
    findText(opts: TextFilter & { limit: number; offset: number }): Promise<LlmTextUsageRow[]>
    countText(filter?: TextFilter): Promise<number>
    getTextStats(): Promise<TextStatRow[]>
    purgePromptText(options: {
        olderThan: Date | null
        dryRun: boolean
        /** Rows per statement; PURGE_BATCH_SIZE unless a test needs several batches. */
        batchSize?: number
    }): Promise<{ matched: number }>
}

/** Rows emptied per statement by the prompt purge (feat-125). */
export const PURGE_BATCH_SIZE = 1000

function buildTextWhere(filter: TextFilter): SQL | undefined {
    const conditions: SQL[] = []
    if (filter.userId !== undefined) conditions.push(eq(llmTextUsage.userId, filter.userId))
    if (filter.dateFrom !== undefined) conditions.push(gte(llmTextUsage.createdAt, filter.dateFrom))
    if (filter.dateTo !== undefined) conditions.push(lte(llmTextUsage.createdAt, filter.dateTo))
    if (filter.feature !== undefined) conditions.push(eq(llmTextUsage.feature, filter.feature))
    return conditions.length > 0 ? and(...conditions) : undefined
}

export const llmUsageRepository: ILlmUsageRepository = {
    async insertText(data) {
        await db.insert(llmTextUsage).values(data)
    },

    async findText({ limit, offset, ...filter }) {
        const where = buildTextWhere(filter)
        const base = db.select().from(llmTextUsage)
        const filtered = where !== undefined ? base.where(where) : base
        return filtered.orderBy(desc(llmTextUsage.createdAt)).limit(limit).offset(offset)
    },

    async countText(filter = {}) {
        const where = buildTextWhere(filter)
        const query = db.select({ count: sql<number>`count(*)::int` }).from(llmTextUsage)
        const result = await (where !== undefined ? query.where(where) : query)
        return result[0]?.count ?? 0
    },

    async purgePromptText({ olderThan, dryRun, batchSize = PURGE_BATCH_SIZE }) {
        const withText = and(
            sql`${llmTextUsage.finalPrompt} <> ''`,
            olderThan === null ? undefined : lte(llmTextUsage.createdAt, olderThan),
        )
        if (dryRun) {
            const [row] = await db
                .select({ count: sql<number>`count(*)::int` })
                .from(llmTextUsage)
                .where(withText)
            return { matched: row?.count ?? 0 }
        }
        // The hash and the length of what is removed are filled in first when the row has none
        // (a row written before they existed); sha256 of the UTF-8 bytes and char_length
        // agree with what the application computes.
        // feat-125 (L10): in batches. One UPDATE over a large table would outlast the main pool's
        // statement_timeout (DB_QUERY_TIMEOUT_MS) every time; each batch is a short statement, and
        // a purged row no longer matches, so the loop ends when a batch finds nothing.
        let matched = 0
        for (;;) {
            const batch = db
                .select({ id: llmTextUsage.id })
                .from(llmTextUsage)
                .where(withText)
                .limit(batchSize)
            const purged = await db
                .update(llmTextUsage)
                .set({
                    promptSha256: sql`coalesce(${llmTextUsage.promptSha256}, encode(sha256(convert_to(${llmTextUsage.finalPrompt}, 'UTF8')), 'hex'))`,
                    promptChars: sql`coalesce(${llmTextUsage.promptChars}, char_length(${llmTextUsage.finalPrompt}))`,
                    finalPrompt: '',
                })
                .where(inArray(llmTextUsage.id, batch))
                .returning({ id: llmTextUsage.id })
            matched += purged.length
            if (purged.length < batchSize) return { matched }
        }
    },

    async getTextStats() {
        const rows = await db
            .select({
                model: llmTextUsage.model,
                feature: llmTextUsage.feature,
                totalCalls: sql<number>`count(*)::int`,
                // bigint: the sum per model × feature can pass 2^31 tokens.
                totalTokens: sql<
                    string | null
                >`sum(${llmTextUsage.totalTokens}) filter (where not ${llmTextUsage.tokensEstimated})::bigint`,
                estimatedTokens: sql<
                    string | null
                >`sum(${llmTextUsage.totalTokens}) filter (where ${llmTextUsage.tokensEstimated})::bigint`,
                callsWithoutUsage: sql<number>`count(*) filter (where ${llmTextUsage.tokensEstimated} or ${llmTextUsage.totalTokens} is null)::int`,
                abortedCalls: sql<number>`count(*) filter (where ${llmTextUsage.status} = 'aborted')::int`,
                failedCalls: sql<number>`count(*) filter (where ${llmTextUsage.status} = 'failed')::int`,
            })
            .from(llmTextUsage)
            .groupBy(llmTextUsage.model, llmTextUsage.feature)
            .orderBy(desc(sql`count(*)`))
        return rows.map((r) => ({
            model: r.model,
            feature: r.feature,
            totalCalls: r.totalCalls,
            totalTokens: r.totalTokens === null ? 0 : Number(r.totalTokens),
            estimatedTokens: r.estimatedTokens === null ? 0 : Number(r.estimatedTokens),
            callsWithoutUsage: r.callsWithoutUsage,
            abortedCalls: r.abortedCalls,
            failedCalls: r.failedCalls,
        }))
    },
}
