import { OAuthLinkConfirmInputSchema } from 'shared/schemas'
import * as ResponseSchemas from 'shared/responses'
import { oauthContracts } from 'shared/contracts'
import { contractSchemas } from '#app/routing/contract-registry.js'

export const oauthSchemas = contractSchemas(oauthContracts, {
    providers: { response: ResponseSchemas.OAuthProvidersResponseSchema },
    confirmLink: {
        body: OAuthLinkConfirmInputSchema,
        response: ResponseSchemas.OAuthLinkConfirmResponseSchema,
    },
    resendEmailLink: { response: ResponseSchemas.EmailLinkResendResponseSchema },
})
