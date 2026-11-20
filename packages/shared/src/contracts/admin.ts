import type {
    AdminOnlineHistoryListQueryInput,
    AdminUserListQueryInput,
} from '../schemas/query/admin.js'
import type { LlmTextUsageQueryInput } from '../schemas/query/usage.js'
import type { AdminAuditEventsQueryInput } from '../schemas/query/admin-audit-events.js'
import type { AdminAuditEventsResponse } from '../responses/admin-audit-events-controller.js'
import type { AdminUserListResponse } from '../responses/admin-user-controller.js'
import type {
    AdminOnlineUserDetailResponse,
    AdminOnlineUserListResponse,
} from '../responses/admin-online-user-controller.js'
import type { AdminOnlineHistoryListResponse } from '../responses/admin-online-history.js'
import type {
    GetTextUsageResponse,
    GetUsageStatsResponse,
} from '../responses/llm-usage-controller.js'
import { contract } from './core.js'

// A query is what a client may send (a number or a numeric string, a date as a string): the
// schema parses it, so its own input type says less than these ones.
export const adminContracts = {
    users: contract<undefined, AdminUserListQueryInput, AdminUserListResponse>()(
        'get',
        '/admin/users',
    ),
    onlineUsers: contract<undefined, undefined, AdminOnlineUserListResponse>()(
        'get',
        '/admin/users-online',
    ),
    onlineUser: contract<undefined, undefined, AdminOnlineUserDetailResponse>()(
        'get',
        '/admin/users-online/:id',
    ),
    onlineHistory: contract<
        undefined,
        AdminOnlineHistoryListQueryInput,
        AdminOnlineHistoryListResponse
    >()('get', '/admin/history-online'),
    textUsage: contract<undefined, LlmTextUsageQueryInput, GetTextUsageResponse>()(
        'get',
        '/admin/usage/text',
    ),
    usageStats: contract<undefined, undefined, GetUsageStatsResponse>()(
        'get',
        '/admin/usage/stats',
    ),
    /** feat-235 (Р7): the audit log, newest first, by the filters of the query. */
    auditEvents: contract<undefined, AdminAuditEventsQueryInput, AdminAuditEventsResponse>()(
        'get',
        '/admin/audit-events',
    ),
} as const
