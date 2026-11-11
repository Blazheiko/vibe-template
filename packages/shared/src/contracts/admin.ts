import type { AdminUserListQueryInput } from '../schemas/query/admin.js'
import type { AdminUserListResponse } from '../responses/admin-user-controller.js'
import { contract } from './core.js'

export const adminContracts = {
    // The query is what a client may send (a number or a numeric string, a date as a string):
    // the schema parses it, so its own input type says less than this one.
    users: contract<undefined, AdminUserListQueryInput, AdminUserListResponse>()(
        'get',
        '/admin/users',
    ),
} as const
