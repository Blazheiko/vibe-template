import { adminWsChannelService } from '#app/services/admin/admin-ws-channel-service.js'
import type { WsContext } from '#vendor/types/types.js'
import { Result } from 'better-result'
import { mapWsControllerError } from '#app/controllers/shared/controller-error.js'
import type { AdminOnlineUsersWsResponse } from 'shared/responses'

export default {
    subscribeOnlineUsers(context: WsContext): AdminOnlineUsersWsResponse {
        const result = adminWsChannelService.subscribeCurrentAdminConnection(context.ws)
        if (Result.isError(result)) {
            return mapWsControllerError(context, result.error)
        }
        return { status: 'success' }
    },

    unsubscribeOnlineUsers(context: WsContext): AdminOnlineUsersWsResponse {
        adminWsChannelService.unsubscribeCurrentAdminConnection(context.ws)
        return { status: 'success' }
    },
}
