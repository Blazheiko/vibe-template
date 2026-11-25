import { adminUserService } from '#app/services/admin/admin-user-service.js'
import { mapControllerError } from '#app/controllers/shared/controller-error.js'
import { badRequest } from '#app/services/shared/errors.js'
import type { HttpContext } from '#vendor/types/types.js'
import type { AdminUserListQuery } from 'shared/schemas'
import type {
    AdminUserListResponse,
    ResetUserMfaResponse,
    SetUserRoleResponse,
} from 'shared/responses'
import type { ResetUserMfaInput, SetUserRoleInput } from 'shared/schemas'
import { mfaResetService } from '#app/services/auth/mfa/mfa-reset-service.js'
import { getTypedPayload } from '#vendor/utils/validation/get-typed-payload.js'
import { auditActorFrom } from '#app/controllers/shared/audit-actor.js'
import { respond } from '#app/controllers/shared/controller-error.js'
import { roleAssignmentService } from '#app/services/user/role-assignment-service.js'
import { toEntityId, parseUserId, type UserId } from '#app/domain/ids.js'

export default {
    async list(context: HttpContext<unknown, AdminUserListQuery>): Promise<AdminUserListResponse> {
        const query = context.httpData.query

        let userId: UserId | undefined
        if (query.userId !== undefined && query.userId !== '') {
            const parsed = parseUserId(query.userId)
            if (parsed === null) {
                return mapControllerError(context, badRequest('userId must be a numeric string'))
            }
            userId = parsed
        }

        let cursor: UserId | undefined
        if (query.cursor !== undefined && query.cursor !== '') {
            const parsed = parseUserId(query.cursor)
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
        const targetUserId = parseUserId(context.httpData.params['id'] ?? '')
        if (targetUserId === null) {
            return mapControllerError(context, badRequest('Invalid user id', 'invalid_user_id'))
        }
        const { role } = getTypedPayload(context)
        const result = await roleAssignmentService.assign({
            actor: auditActorFrom(context),
            targetUserId,
            role,
            sessionAuth: context.session.sessionInfo?.data.auth,
            presentedSessionToken: context.auth.getPresentedUserToken(),
            sessionStored: () => context.session.isStored(),
        })
        return respond(context, result, (value) => ({
            status: 'success' as const,
            user: { id: toEntityId(value.userId), role: value.role },
            changed: value.changed,
        }))
    },

    /**
     * POST /admin/users/:id/mfa/reset (feat-247, Р13). The guard checked users.mfa.reset; the
     * service asks the admin's fresh proof, refuses the own account and an account that would be
     * left without a way to sign in, removes the factors and ends the target's sessions.
     */
    async resetMfa(context: HttpContext<ResetUserMfaInput>): Promise<ResetUserMfaResponse> {
        const targetUserId = parseUserId(context.httpData.params['id'] ?? '')
        if (targetUserId === null) {
            return mapControllerError(context, badRequest('Invalid user id', 'invalid_user_id'))
        }
        const result = await mfaResetService.reset({
            actor: auditActorFrom(context),
            targetUserId,
            reason: getTypedPayload(context).reason,
            sessionAuth: context.session.sessionInfo?.data.auth,
            presentedSessionToken: context.auth.getPresentedUserToken(),
            sessionStored: () => context.session.isStored(),
        })
        return respond(context, result, (value) => ({
            status: 'success' as const,
            user: { id: toEntityId(value.userId) },
            removed: value.removed,
        }))
    },
}
