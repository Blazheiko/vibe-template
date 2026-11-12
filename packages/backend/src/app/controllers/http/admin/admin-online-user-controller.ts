import { adminOnlineUsersService } from '#app/services/admin/admin-online-users-service.js'
import { mapControllerError } from '#app/controllers/shared/controller-error.js'
import { badRequest, notFound } from '#app/services/shared/errors.js'
import type { HttpContext } from '#vendor/types/types.js'
import type { ParamsOf } from '#app/routing/contract-registry.js'
import type { adminContracts } from 'shared/contracts'
import type { AdminOnlineUserDetailResponse, AdminOnlineUserListResponse } from 'shared/responses'
import { parseEntityId } from '#app/controllers/shared/parse-id.js'

export default {
    async list(_context: HttpContext): Promise<AdminOnlineUserListResponse> {
        const items = await adminOnlineUsersService.listOnlineUsers()
        return {
            status: 'success',
            items,
            total: items.length,
        }
    },

    async getById(
        context: HttpContext<unknown, null, ParamsOf<typeof adminContracts.onlineUser>>,
    ): Promise<AdminOnlineUserDetailResponse> {
        const id = parseEntityId(context.httpData.params.id)
        if (id === null) {
            return mapControllerError(context, badRequest('Invalid user id'))
        }

        const user = await adminOnlineUsersService.getOnlineUserDetail(id)
        if (user === undefined) {
            return mapControllerError(context, notFound('User', 'User not found'))
        }

        return {
            status: 'success',
            user,
        }
    },
}
