import type { SupportChatInputSchema } from '../schemas/support/support-chat.js'
import type { SupportOpenChatInputSchema } from '../schemas/support/support-open-chat.js'
import type { AdminOnlineUsersWsResponse } from '../responses/admin-online-user-controller.js'
import type {
    SupportChatResponse,
    SupportOpenChatResponse,
} from '../responses/support-controller.js'
import { wsContract } from './core.js'

// Requests over the WebSocket (ADR 0006). The events the server pushes on its own are the
// broadcast events of shared/schemas/ws/broadcast-events.ts.
export const adminWsContracts = {
    subscribeOnlineUsers: wsContract<undefined, AdminOnlineUsersWsResponse>()(
        '/admin/subscribe_online_users',
    ),
    unsubscribeOnlineUsers: wsContract<undefined, AdminOnlineUsersWsResponse>()(
        '/admin/unsubscribe_online_users',
    ),
} as const

export const supportWsContracts = {
    openChat: wsContract<typeof SupportOpenChatInputSchema.inferIn, SupportOpenChatResponse>()(
        '/support/support_open_chat',
    ),
    chat: wsContract<typeof SupportChatInputSchema.inferIn, SupportChatResponse>()(
        '/support/support_chat',
    ),
} as const
