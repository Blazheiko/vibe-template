import { db } from '#database/db.js'
import { llmTextUsage } from '#database/schema.js'
import { eq, sql, desc, and, gte, lte } from 'drizzle-orm'
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
/**
 * Where a purge or a dry-run count stands: the last row of the previous batch, in the order of
 * the index. Kept as the database's text: `created_at` has microseconds a JS Date would drop,
 * and a cursor that moved back would count rows again.
 */
interface PurgeBatchRow {
    selected: number
    changed: number
    last_created_at: string | null
    last_id: string | null
}

export interface PromptPurgeCursor {
    createdAt: string
    id: string
}

/**
 * feat-224: one batch of the purge, or of its dry-run count (exported for the plan test). The
 * batch walks the partial index `llm_text_usage_prompt_text_created_at_idx` (`created_at`,
 * `id` WHERE text is kept) from the cursor on: every statement reads at most `limit` index
 * entries, also on a table where every row still holds text (a first run) and while entries of
 * rows emptied earlier are not yet cleaned up (a long snapshot elsewhere keeps them). feat-130
 * paged the whole table by id for the same reason; this walks only the rows that hold text.
 *
 * The UPDATE repeats `final_prompt <> ''`, so a row another run emptied meanwhile is skipped,
 * not counted twice. The hash and the length are filled only where missing (a row written before
 * they existed); sha256 of the UTF-8 bytes and char_length agree with what the application
 * computes. The cut-off goes in as ISO text, the way drizzle writes a Date to this column.
 */
export function promptPurgeBatch(
    olderThan: Date | null,
    cursor: PromptPurgeCursor | null,
    limit: number,
    dryRun: boolean,
): SQL {
    const t = llmTextUsage
    const conditions: SQL[] = [sql`${t.finalPrompt} <> ''`]
    if (olderThan !== null) {
        conditions.push(sql`${t.createdAt} <= ${olderThan.toISOString()}::timestamp`)
    }
    if (cursor !== null) {
        conditions.push(
            sql`(${t.createdAt}, ${t.id}) > (${cursor.createdAt}::timestamp, ${cursor.id}::bigint)`,
        )
    }
    const batch = sql`select ${t.id} as id, ${t.createdAt} as created_at from ${t}
        where ${sql.join(conditions, sql` and `)}
        order by ${t.createdAt}, ${t.id} limit ${limit}`
    const changed = dryRun ? sql`0` : sql`(select count(*) from purged)::int`
    const purged = dryRun
        ? sql``
        : sql`, purged as (
            update ${t} set
                ${sql.identifier('prompt_sha256')} = coalesce(${t.promptSha256}, encode(sha256(convert_to(${t.finalPrompt}, 'UTF8')), 'hex')),
                ${sql.identifier('prompt_chars')} = coalesce(${t.promptChars}, char_length(${t.finalPrompt})),
                ${sql.identifier('final_prompt')} = ''
            where ${t.id} = any(array(select id from batch)) and ${t.finalPrompt} <> ''
            returning 1
        )`
    return sql`with batch as materialized (${batch})${purged}
        select (select count(*) from batch)::int as selected,
               ${changed} as changed,
               last.created_at::text as last_created_at,
               last.id::text as last_id
        from (select 1) one
        left join lateral (
            select created_at, id from batch order by created_at desc, id desc limit 1
        ) last on true`
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
        let matched = 0
        let changed = 0
        let cursor: PromptPurgeCursor | null = null
        for (;;) {
            checkpoint()
            const result: { rows: PurgeBatchRow[] } = await db.execute<PurgeBatchRow>(
                promptPurgeBatch(olderThan, cursor, batchSize, dryRun),
            )
            const row: PurgeBatchRow | undefined = result.rows[0]
            const selected = row?.selected ?? 0
            matched += selected
            changed += row?.changed ?? 0
            if (selected < batchSize || row?.last_created_at == null || row.last_id == null) {
                return { matched, changed }
            }
            cursor = { createdAt: row.last_created_at, id: row.last_id }
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
