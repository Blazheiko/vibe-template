import { EmptyFormInputSchema, TotpConfirmInputSchema } from 'shared/schemas'
import * as ResponseSchemas from 'shared/responses'
import { mfaContracts } from 'shared/contracts'
import { contractSchemas } from '#app/routing/contract-registry.js'

export const mfaSchemas = contractSchemas(mfaContracts, {
    status: { response: ResponseSchemas.MfaStatusResponseSchema },
    totpSetup: { body: EmptyFormInputSchema, response: ResponseSchemas.TotpSetupResponseSchema },
    totpConfirm: {
        body: TotpConfirmInputSchema,
        response: ResponseSchemas.TotpConfirmResponseSchema,
    },
    totpDisable: { response: ResponseSchemas.TotpDisableResponseSchema },
    regenerateRecoveryCodes: {
        body: EmptyFormInputSchema,
        response: ResponseSchemas.RecoveryCodesResponseSchema,
    },
})
