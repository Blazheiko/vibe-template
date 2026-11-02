import { adminWsChannelService } from '#app/services/admin/admin-ws-channel-service.js'
import type { WsContext } from '#vendor/types/types.js'
import { Result } from 'better-result'
import { appErrorToPayload } from '#app/services/shared/app-error-payload.js'
import type { AdminOnlineUsersWsResponse } from 'shared/responses'

export default {
    subscribeOnlineUsers(context: WsContext): AdminOnlineUsersWsResponse {
        const result = adminWsChannelService.subscribeCurrentAdminConnection(context.ws)
        if (Result.isError(result)) {
            context.responseData.status = '403'
            return appErrorToPayload(result.error)
        }
        return { status: 'success' }
    },

    unsubscribeOnlineUsers(context: WsContext): AdminOnlineUsersWsResponse {
        adminWsChannelService.unsubscribeCurrentAdminConnection(context.ws)
        return { status: 'success' }
    },
}
