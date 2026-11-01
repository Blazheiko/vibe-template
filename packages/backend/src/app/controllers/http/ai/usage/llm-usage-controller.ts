import type { HttpContext } from '#vendor/types/types.js'
import { llmUsageService, type TextFilter } from '#app/services/ai/usage/llm-usage-service.js'
import type { LlmTextUsageQuery } from 'shared/schemas'
import type { GetTextUsageResponse, GetUsageStatsResponse } from 'shared'

function buildTextFilter(query: LlmTextUsageQuery): TextFilter {
    const filter: TextFilter = {}
    if (query.userId !== undefined && query.userId.trim().length > 0) {
        const userId = query.userId.trim()
        try {
            filter.userId = BigInt(userId.trim())
        } catch {
            /* ignore invalid */
        }
    }
    if (query.dateFrom !== undefined) {
        filter.dateFrom = query.dateFrom
    }
    if (query.dateTo !== undefined) {
        filter.dateTo = query.dateTo
    }
    if (query.feature !== undefined) {
        filter.feature = query.feature
    }
    return filter
}

export default {
    async getTextUsage(
        context: HttpContext<unknown, LlmTextUsageQuery>,
    ): Promise<GetTextUsageResponse> {
        const { page, limit } = context.httpData.query
        const offset = (page - 1) * limit
        const filter = buildTextFilter(context.httpData.query)

        const { rows, total } = await llmUsageService.getTextUsage({ limit, offset, filter })

        const serialized = rows.map((r) => ({
            id: String(r.id),
            userId: r.userId === null ? null : String(r.userId),
            model: r.model,
            feature: r.feature,
            // '' means the text is not kept (feat-065): answered as "no text", not as an
            // empty prompt. The hash and the length are there for rows written since.
            finalPrompt: r.finalPrompt === '' ? null : r.finalPrompt,
            promptSha256: r.promptSha256,
            promptChars: r.promptChars,
            promptTokens: r.promptTokens,
            completionTokens: r.completionTokens,
            totalTokens: r.totalTokens,
            createdAt: r.createdAt.toISOString(),
        }))

        return { status: 'success', data: { rows: serialized, total, page, limit } }
    },

    async getStats(_context: HttpContext): Promise<GetUsageStatsResponse> {
        const { text } = await llmUsageService.getStats()
        return { status: 'success', data: { text } }
    },
}
