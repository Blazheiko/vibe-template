import type { HttpContext } from '#vendor/types/types.js'
import type { AdminAuditEventsQuery } from 'shared/schemas'
import type { AdminAuditEventsResponse } from 'shared/responses'
import { respond } from '#app/controllers/shared/controller-error.js'
import { auditEventsQueryService } from '#app/services/admin/audit-events-query-service.js'

// feat-235 (Р7): GET /admin/audit-events. The query schema has checked every filter already;
// the ids are canonical digits, so BigInt cannot throw.
export default {
    async list(
        context: HttpContext<unknown, AdminAuditEventsQuery>,
    ): Promise<AdminAuditEventsResponse> {
        const query = context.httpData.query
        const result = await auditEventsQueryService.list({
            ...(query.action !== undefined && { actions: query.action }),
            ...(query.group !== undefined && { group: query.group }),
            ...(query.actorUserId !== undefined && { actorUserId: BigInt(query.actorUserId) }),
            ...(query.targetUserId !== undefined && { targetUserId: BigInt(query.targetUserId) }),
            ...(query.targetType !== undefined && { targetType: query.targetType }),
            ...(query.targetId !== undefined && { targetId: query.targetId }),
            ...(query.requestId !== undefined && { requestId: query.requestId }),
            ...(query.from !== undefined && { from: query.from }),
            ...(query.to !== undefined && { to: query.to }),
            ...(query.cursor !== undefined && { cursor: query.cursor }),
        })
        return respond(context, result, (value) => ({
            status: 'success' as const,
            items: value.items,
            nextCursor: value.nextCursor,
        }))
    },
}
