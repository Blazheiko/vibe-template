import { adminOnlineHistoryService } from '#app/services/admin/admin-online-history-service.js'
import { mapControllerError } from '#app/controllers/shared/controller-error.js'
import { badRequest } from '#app/services/shared/errors.js'
import type { AdminOnlineHistoryListQuery } from 'shared/schemas'
import type { HttpContext } from '#vendor/types/types.js'
import type { AdminOnlineHistoryListResponse } from 'shared/responses'
import { parseUserId, type UserId, parseUserOnlineId, type UserOnlineId } from '#app/domain/ids.js'

export default {
    async list(
        context: HttpContext<unknown, AdminOnlineHistoryListQuery>,
    ): Promise<AdminOnlineHistoryListResponse> {
        const query = context.httpData.query

        let userId: UserId | undefined
        if (query.userId !== undefined && query.userId !== '') {
            const parsed = parseUserId(query.userId)
            if (parsed === null) {
                return mapControllerError(context, badRequest('userId must be a numeric string'))
            }
            userId = parsed
        }

        let cursor: UserOnlineId | undefined
        if (query.cursor !== undefined && query.cursor !== '') {
            const parsed = parseUserOnlineId(query.cursor)
            if (parsed === null) {
                return mapControllerError(context, badRequest('cursor must be a numeric string'))
            }
            cursor = parsed
        }

        const result = await adminOnlineHistoryService.listHistory({
            ...(userId !== undefined && { userId }),
            ...(cursor !== undefined && { cursor }),
            ...(query.dateFrom !== undefined && { dateFrom: query.dateFrom }),
            ...(query.dateTo !== undefined && { dateTo: query.dateTo }),
            limit: query.limit,
        })

        return {
            status: 'success',
            items: result.items,
            total: result.total,
            limit: result.limit,
            nextCursor: result.nextCursor,
            hasMore: result.hasMore,
        }
    },
}
