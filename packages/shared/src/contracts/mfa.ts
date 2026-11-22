import type { EmptyFormInputSchema } from '../schemas/common/empty-form.js'
import type { TotpConfirmInputSchema } from '../schemas/mfa/totp-confirm.js'
import type {
    MfaStatusResponse,
    RecoveryCodesResponse,
    TotpConfirmResponse,
    TotpDisableResponse,
    TotpSetupResponse,
} from '../responses/mfa-controller.js'
import { contract } from './core.js'

type EmptyBody = typeof EmptyFormInputSchema.inferIn

// feat-245 (docs/plan/passkeys-mfa-plan.md, Р3, Р7, Р8): the second factors of the signed-in
// account. Every change goes through the proof matrix (403 `reauth_required` lists the proofs).
export const mfaContracts = {
    status: contract<undefined, undefined, MfaStatusResponse>()('get', '/account/mfa'),
    totpSetup: contract<EmptyBody, undefined, TotpSetupResponse>()(
        'post',
        '/account/mfa/totp/setup',
    ),
    totpConfirm: contract<typeof TotpConfirmInputSchema.inferIn, undefined, TotpConfirmResponse>()(
        'post',
        '/account/mfa/totp/confirm',
    ),
    totpDisable: contract<undefined, undefined, TotpDisableResponse>()(
        'delete',
        '/account/mfa/totp',
    ),
    regenerateRecoveryCodes: contract<EmptyBody, undefined, RecoveryCodesResponse>()(
        'post',
        '/account/mfa/recovery-codes',
    ),
}
