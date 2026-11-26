import type { HttpContext } from '#vendor/types/types.js'
import type { AdminAuditEventsQuery } from 'shared/schemas'
import type { AdminAuditEventsResponse } from 'shared/responses'
import { mapControllerError, respond } from '#app/controllers/shared/controller-error.js'
import { parseUserId } from '#app/domain/ids.js'
import { badRequest } from '#app/services/shared/errors.js'
import { auditEventsQueryService } from '#app/services/admin/audit-events-query-service.js'
import { guardedRoleOf } from '#app/controllers/shared/audit-actor.js'
import { roleHasPermission } from 'shared/access'

// feat-235 (Р7): GET /admin/audit-events. The query schema has checked the shape of every filter;
// an id PostgreSQL's bigint cannot hold is refused here with 400 instead of reaching the query.
export default {
    async list(
        context: HttpContext<unknown, AdminAuditEventsQuery>,
    ): Promise<AdminAuditEventsResponse> {
        const query = context.httpData.query
        const actorUserId =
            query.actorUserId === undefined ? undefined : parseUserId(query.actorUserId)
        const targetUserId =
            query.targetUserId === undefined ? undefined : parseUserId(query.targetUserId)
        if (actorUserId === null || targetUserId === null) {
            return mapControllerError(context, badRequest('Invalid user id', 'invalid_user_id'))
        }
        // feat-240 (Р5): without audit.read the reader sees the sign-in and session events only.
        const scope = roleHasPermission(guardedRoleOf(context), 'audit.read') ? 'all' : 'account'
        const result = await auditEventsQueryService.list(
            {
                ...(query.action !== undefined && { actions: query.action }),
                ...(query.group !== undefined && { group: query.group }),
                ...(actorUserId !== undefined && { actorUserId }),
                ...(targetUserId !== undefined && { targetUserId }),
                ...(query.targetType !== undefined && { targetType: query.targetType }),
                ...(query.targetId !== undefined && { targetId: query.targetId }),
                ...(query.requestId !== undefined && { requestId: query.requestId }),
                ...(query.from !== undefined && { from: query.from }),
                ...(query.to !== undefined && { to: query.to }),
                ...(query.cursor !== undefined && { cursor: query.cursor }),
            },
            scope,
        )
        return respond(context, result, (value) => ({
            status: 'success' as const,
            items: value.items,
            nextCursor: value.nextCursor,
        }))
    },
}
