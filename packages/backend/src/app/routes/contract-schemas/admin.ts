import {
    AdminOnlineHistoryListQuerySchema,
    AdminUserListQuerySchema,
    LlmTextUsageQuerySchema,
} from 'shared/schemas'
import * as ResponseSchemas from 'shared/responses'
import { adminContracts } from 'shared/contracts'
import { contractSchemas } from '#app/routing/contract-registry.js'

export const adminSchemas = contractSchemas(adminContracts, {
    users: {
        query: AdminUserListQuerySchema,
        response: ResponseSchemas.AdminUserListResponseSchema,
    },
    onlineUsers: { response: ResponseSchemas.AdminOnlineUserListResponseSchema },
    onlineUser: { response: ResponseSchemas.AdminOnlineUserDetailResponseSchema },
    onlineHistory: {
        query: AdminOnlineHistoryListQuerySchema,
        response: ResponseSchemas.AdminOnlineHistoryListResponseSchema,
    },
    textUsage: {
        query: LlmTextUsageQuerySchema,
        response: ResponseSchemas.GetTextUsageResponseSchema,
    },
    usageStats: { response: ResponseSchemas.GetUsageStatsResponseSchema },
})
