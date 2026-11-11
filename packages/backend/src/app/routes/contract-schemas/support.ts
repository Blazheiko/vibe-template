import { SupportChatHistoryQuerySchema } from 'shared/schemas'
import * as ResponseSchemas from 'shared/responses'
import { supportContracts } from 'shared/contracts'
import { contractSchemas } from '#app/routing/contract-registry.js'

export const supportSchemas = contractSchemas(supportContracts, {
    history: {
        query: SupportChatHistoryQuerySchema,
        response: ResponseSchemas.SupportGetChatHistoryResponseSchema,
    },
    deleteHistory: { response: ResponseSchemas.SupportDeleteChatHistoryResponseSchema },
})
