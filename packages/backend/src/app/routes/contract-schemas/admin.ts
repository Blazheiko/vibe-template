import { AdminUserListQuerySchema } from 'shared/schemas'
import * as ResponseSchemas from 'shared/responses'
import { adminContracts } from 'shared/contracts'
import { contractSchemas } from '#app/routing/contract-registry.js'

export const adminSchemas = contractSchemas(adminContracts, {
    users: {
        query: AdminUserListQuerySchema,
        response: ResponseSchemas.AdminUserListResponseSchema,
    },
})
