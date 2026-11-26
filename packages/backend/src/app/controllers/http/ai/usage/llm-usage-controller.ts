import type { HttpContext } from '#vendor/types/types.js'
import { toIsoDateTime } from 'shared/brand'
import { llmUsageService, type TextFilter } from '#app/services/ai/usage/llm-usage-service.js'
import { mapControllerError } from '#app/controllers/shared/controller-error.js'
import { parseUserId, toEntityId } from '#app/domain/ids.js'
import { badRequest } from '#app/services/shared/errors.js'
import type { LlmTextUsageQuery } from 'shared/schemas'
import type { GetTextUsageResponse, GetUsageStatsResponse } from 'shared'

/**
 * The filter of the query, or null when `userId` is given and is not an id (feat-262). An empty
 * `userId` means no filter, as in the admin user list; anything else that is not the canonical id
 * of a row (`abc`, ` 1`, `0x10`) is a bad request instead of a silently dropped filter.
 */
function buildTextFilter(query: LlmTextUsageQuery): TextFilter | null {
    const filter: TextFilter = {}
    if (query.userId !== undefined && query.userId !== '') {
        const userId = parseUserId(query.userId)
        if (userId === null) return null
        filter.userId = userId
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
        if (filter === null) {
            return mapControllerError(context, badRequest('userId must be a numeric string'))
        }

        const { rows, total } = await llmUsageService.getTextUsage({ limit, offset, filter })

        const serialized = rows.map((r) => ({
            id: toEntityId(r.id),
            userId: r.userId === null ? null : toEntityId(r.userId),
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
            status: r.status,
            tokensEstimated: r.tokensEstimated,
            createdAt: toIsoDateTime(r.createdAt),
        }))

        return { status: 'success', data: { rows: serialized, total, page, limit } }
    },

    async getStats(_context: HttpContext): Promise<GetUsageStatsResponse> {
        const { text } = await llmUsageService.getStats()
        return { status: 'success', data: { text } }
    },
}
