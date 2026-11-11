import { LoginInputSchema } from 'shared/schemas'
import * as ResponseSchemas from 'shared/responses'
import { authContracts } from 'shared/contracts'
import { contractSchemas } from '#app/routing/contract-registry.js'

export const authSchemas = contractSchemas(authContracts, {
    login: { body: LoginInputSchema, response: ResponseSchemas.LoginResponseSchema },
})
