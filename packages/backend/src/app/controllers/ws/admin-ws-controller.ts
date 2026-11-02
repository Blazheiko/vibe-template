import { adminWsChannelService } from '#app/services/admin/admin-ws-channel-service.js'
import type { WsContext } from '#vendor/types/types.js'
import { respondWs } from '#app/controllers/shared/controller-error.js'
import type { AdminOnlineUsersWsResponse } from 'shared/responses'

export default {
    subscribeOnlineUsers(context: WsContext): AdminOnlineUsersWsResponse {
        const result = adminWsChannelService.subscribeCurrentAdminConnection(context.ws)
        return respondWs(context, result, () => ({ status: 'success' }))
    },

    unsubscribeOnlineUsers(context: WsContext): AdminOnlineUsersWsResponse {
        adminWsChannelService.unsubscribeCurrentAdminConnection(context.ws)
        return { status: 'success' }
    },
}
