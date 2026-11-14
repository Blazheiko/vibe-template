import { EmptyFormInputSchema } from 'shared/schemas'
import * as ResponseSchemas from 'shared/responses'
import { avatarContracts } from 'shared/contracts'
import { contractSchemas } from '#app/routing/contract-registry.js'

export const avatarSchemas = contractSchemas(avatarContracts, {
    upload: { body: EmptyFormInputSchema, response: ResponseSchemas.UploadAvatarResponseSchema },
    remove: { response: ResponseSchemas.DeleteAvatarResponseSchema },
})
