import { db } from '#database/db.js'
import { llmTextUsage } from '#database/schema.js'
import { eq, sql, desc, and, asc, gte, lte } from 'drizzle-orm'
import type { InferInsertModel, InferSelectModel, SQL } from 'drizzle-orm'
import { noCheckpoint, type Checkpoint } from '#app/services/shared/checkpoint.js'
import type { PurgeCounts } from '#app/services/shared/purge-counts.js'

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
    /**
     * Empties the prompt text created at or before `olderThan` (all of it when null) and keeps
     * its hash and length. In batches of `batchSize`, `checkpoint()` right before every
     * statement; a dry run only counts (`changed` 0). Two concurrent runs change each row once.
     */
    purgePromptText(options: {
        olderThan: Date | null
        dryRun: boolean
        /** Rows per statement; PURGE_BATCH_SIZE unless a test needs several batches. */
        batchSize?: number
        checkpoint?: Checkpoint
    }): Promise<PurgeCounts>
}

/** Rows emptied per statement by the prompt purge (feat-125). */
export const PURGE_BATCH_SIZE = 1000

/** The rows with prompt text created at or before `olderThan` (all of them when null). */
const withPromptText = (olderThan: Date | null): SQL | undefined =>
    and(
        sql`${llmTextUsage.finalPrompt} <> ''`,
        olderThan === null ? undefined : lte(llmTextUsage.createdAt, olderThan),
    )

/**
 * feat-224: one batch of the purge (exported for the plan test). The batch is read from the
 * partial index `llm_text_usage_prompt_text_created_at_idx` (`created_at` WHERE text is kept):
 * a purged row leaves the index, so a batch reads at most `limit` entries however long the
 * history is. The id paging of feat-130 walked the whole table on every run. The outer
 * condition repeats `final_prompt <> ''`, so a row another run emptied meanwhile is not
 * counted twice. The hash and the length are filled only where missing (a row written before
 * they existed); sha256 of the UTF-8 bytes and char_length agree with what the application
 * computes.
 */
export function promptPurgeBatch(olderThan: Date | null, limit: number): SQL {
    const batch = db
        .select({ id: llmTextUsage.id })
        .from(llmTextUsage)
        .where(withPromptText(olderThan))
        .orderBy(asc(llmTextUsage.createdAt))
        .limit(limit)
    return sql`update ${llmTextUsage} set
        ${sql.identifier('prompt_sha256')} = coalesce(${llmTextUsage.promptSha256}, encode(sha256(convert_to(${llmTextUsage.finalPrompt}, 'UTF8')), 'hex')),
        ${sql.identifier('prompt_chars')} = coalesce(${llmTextUsage.promptChars}, char_length(${llmTextUsage.finalPrompt})),
        ${sql.identifier('final_prompt')} = ''
        where ${llmTextUsage.id} = any(array(${batch})) and ${llmTextUsage.finalPrompt} <> ''
        returning ${llmTextUsage.id}`
}

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

    async purgePromptText({
        olderThan,
        dryRun,
        batchSize = PURGE_BATCH_SIZE,
        checkpoint = noCheckpoint,
    }) {
        if (dryRun) {
            // One statement over the partial index: it touches only rows that still hold text.
            checkpoint()
            const [row] = await db
                .select({ count: sql<number>`count(*)::int` })
                .from(llmTextUsage)
                .where(withPromptText(olderThan))
            return { matched: row?.count ?? 0, changed: 0 }
        }
        let changed = 0
        for (;;) {
            checkpoint()
            const result = await db.execute<{ id: unknown }>(promptPurgeBatch(olderThan, batchSize))
            changed += result.rows.length
            if (result.rows.length < batchSize) return { matched: changed, changed }
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
