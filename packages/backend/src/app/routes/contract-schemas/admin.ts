import {
    AdminAuditEventsQuerySchema,
    AdminOnlineHistoryListQuerySchema,
    AdminUserListQuerySchema,
    LlmTextUsageQuerySchema,
    SetUserRoleInputSchema,
    ResetUserMfaInputSchema,
} from 'shared/schemas'
import * as ResponseSchemas from 'shared/responses'
import { adminContracts } from 'shared/contracts'
import { contractSchemas } from '#app/routing/contract-registry.js'

export const adminSchemas = contractSchemas(adminContracts, {
    users: {
        query: AdminUserListQuerySchema,
        response: ResponseSchemas.AdminUserListResponseSchema,
    },
    setUserRole: {
        body: SetUserRoleInputSchema,
        response: ResponseSchemas.SetUserRoleResponseSchema,
    },
    resetUserMfa: {
        body: ResetUserMfaInputSchema,
        response: ResponseSchemas.ResetUserMfaResponseSchema,
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
    auditEvents: {
        query: AdminAuditEventsQuerySchema,
        response: ResponseSchemas.AdminAuditEventsResponseSchema,
    },
})
