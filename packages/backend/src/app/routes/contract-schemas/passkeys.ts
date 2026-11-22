import {
    EmptyFormInputSchema,
    PasskeyRegisterInputSchema,
    PasskeyRenameInputSchema,
} from 'shared/schemas'
import * as ResponseSchemas from 'shared/responses'
import { passkeyContracts } from 'shared/contracts'
import { contractSchemas } from '#app/routing/contract-registry.js'

export const passkeySchemas = contractSchemas(passkeyContracts, {
    list: { response: ResponseSchemas.PasskeyListResponseSchema },
    registerOptions: {
        body: EmptyFormInputSchema,
        response: ResponseSchemas.PasskeyOptionsResponseSchema,
    },
    register: {
        body: PasskeyRegisterInputSchema,
        response: ResponseSchemas.PasskeyRegisterResponseSchema,
    },
    rename: {
        body: PasskeyRenameInputSchema,
        response: ResponseSchemas.PasskeyRenameResponseSchema,
    },
    remove: { response: ResponseSchemas.PasskeyDeleteResponseSchema },
})
