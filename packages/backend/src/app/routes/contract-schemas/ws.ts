import { SupportChatInputSchema, SupportOpenChatInputSchema } from 'shared/schemas'
import * as ResponseSchemas from 'shared/responses'
import { adminWsContracts, supportWsContracts } from 'shared/contracts'
import { contractSchemas } from '#app/routing/contract-registry.js'

// WS requests (ADR 0006): keyed `ws <event>`, apart from every HTTP route.
export const adminWsSchemas = contractSchemas(adminWsContracts, {
    subscribeOnlineUsers: { response: ResponseSchemas.AdminOnlineUsersWsResponseSchema },
    unsubscribeOnlineUsers: { response: ResponseSchemas.AdminOnlineUsersWsResponseSchema },
})

export const supportWsSchemas = contractSchemas(supportWsContracts, {
    openChat: {
        body: SupportOpenChatInputSchema,
        response: ResponseSchemas.SupportOpenChatResponseSchema,
    },
    chat: { body: SupportChatInputSchema, response: ResponseSchemas.SupportChatResponseSchema },
})
