import { adminUserService } from '#app/services/admin/admin-user-service.js'
import { mapControllerError } from '#app/controllers/shared/controller-error.js'
import { badRequest } from '#app/services/shared/errors.js'
import type { HttpContext } from '#vendor/types/types.js'
import type { AdminUserListQuery } from 'shared/schemas'
import type { AdminUserListResponse, SetUserRoleResponse } from 'shared/responses'
import type { SetUserRoleInput } from 'shared/schemas'
import { getTypedPayload } from '#vendor/utils/validation/get-typed-payload.js'
import { auditActorFrom } from '#app/controllers/shared/audit-actor.js'
import { respond } from '#app/controllers/shared/controller-error.js'
import { roleAssignmentService } from '#app/services/user/role-assignment-service.js'
import { parseEntityId } from '#app/controllers/shared/parse-id.js'

export default {
    async list(context: HttpContext<unknown, AdminUserListQuery>): Promise<AdminUserListResponse> {
        const query = context.httpData.query

        let userId: bigint | undefined
        if (query.userId !== undefined && query.userId !== '') {
            const parsed = parseEntityId(query.userId)
            if (parsed === null) {
                return mapControllerError(context, badRequest('userId must be a numeric string'))
            }
            userId = parsed
        }

        let cursor: bigint | undefined
        if (query.cursor !== undefined && query.cursor !== '') {
            const parsed = parseEntityId(query.cursor)
            if (parsed === null) {
                return mapControllerError(context, badRequest('cursor must be a numeric string'))
            }
            cursor = parsed
        }

        const filters = {
            ...(userId !== undefined && { userId }),
            ...(cursor !== undefined && { cursor }),
            ...(query.role !== undefined && { role: query.role }),
            ...(query.dateFrom !== undefined && { dateFrom: query.dateFrom }),
            ...(query.dateTo !== undefined && { dateTo: query.dateTo }),
            limit: query.limit,
        }

        const result = await adminUserService.listUsers(filters)

        return {
            status: 'success',
            items: result.items,
            total: result.total,
            nextCursor: result.nextCursor,
            hasMore: result.hasMore,
        }
    },

    /**
     * PATCH /admin/users/:id/role (feat-241, Р6). The guard checked users.roles.assign; the
     * service checks the rest under its lock: the delegation policy, the own role, a verified
     * email for a staff role and the last admin.
     */
    async setRole(context: HttpContext<SetUserRoleInput>): Promise<SetUserRoleResponse> {
        const targetUserId = parseEntityId(context.httpData.params['id'] ?? '')
        if (targetUserId === null) {
            return mapControllerError(context, badRequest('Invalid user id', 'invalid_user_id'))
        }
        const { role } = getTypedPayload(context)
        const result = await roleAssignmentService.assign({
            actor: auditActorFrom(context),
            targetUserId,
            role,
            sessionAuth: context.session.sessionInfo?.data.auth,
        })
        return respond(context, result, (value) => ({
            status: 'success' as const,
            user: { id: String(value.userId), role: value.role },
            changed: value.changed,
        }))
    },
}
