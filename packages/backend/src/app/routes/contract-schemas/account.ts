import {
    EmptyFormInputSchema,
    ListSessionsQuerySchema,
    UpdateProfileInputSchema,
} from 'shared/schemas'
import * as ResponseSchemas from 'shared/responses'
import { accountContracts } from 'shared/contracts'
import { contractSchemas } from '#app/routing/contract-registry.js'

export const accountSchemas = contractSchemas(accountContracts, {
    getProfile: { response: ResponseSchemas.GetProfileResponseSchema },
    updateProfile: {
        body: UpdateProfileInputSchema,
        response: ResponseSchemas.UpdateProfileResponseSchema,
    },
    listSessions: {
        query: ListSessionsQuerySchema,
        response: ResponseSchemas.ListSessionsResponseSchema,
    },
    revokeSession: { response: ResponseSchemas.RevokeSessionResponseSchema },
    revokeOtherSessions: {
        body: EmptyFormInputSchema,
        response: ResponseSchemas.RevokeOtherSessionsResponseSchema,
    },
})
