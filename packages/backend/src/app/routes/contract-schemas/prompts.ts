import { PromptTestInputSchema, PromptUpdateInputSchema } from 'shared/schemas'
import * as ResponseSchemas from 'shared/responses'
import { promptContracts } from 'shared/contracts'
import { contractSchemas } from '#app/routing/contract-registry.js'

export const promptSchemas = contractSchemas(promptContracts, {
    list: { response: ResponseSchemas.PromptGetListResponseSchema },
    get: { response: ResponseSchemas.PromptGetByTypeResponseSchema },
    update: {
        body: PromptUpdateInputSchema,
        response: ResponseSchemas.PromptUpdateResponseSchema,
    },
    test: { body: PromptTestInputSchema, response: ResponseSchemas.PromptTestResponseSchema },
})
