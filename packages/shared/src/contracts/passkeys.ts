import type { EmptyFormInputSchema } from '../schemas/common/empty-form.js'
import type {
    PasskeyRegisterInputSchema,
    PasskeyRenameInputSchema,
} from '../schemas/passkeys/passkey-register.js'
import type {
    PasskeyDeleteResponse,
    PasskeyListResponse,
    PasskeyOptionsResponse,
    PasskeyRegisterResponse,
    PasskeyRenameResponse,
} from '../responses/passkeys-controller.js'
import { contract } from './core.js'

type EmptyBody = typeof EmptyFormInputSchema.inferIn

// feat-246 (docs/plan/passkeys-mfa-plan.md, Р3 rows 1–3, Р6, Р12): the passkeys of the signed-in
// account. Adding and removing go through the proof matrix (403 `reauth_required`).
export const passkeyContracts = {
    list: contract<undefined, undefined, PasskeyListResponse>()('get', '/account/passkeys'),
    registerOptions: contract<EmptyBody, undefined, PasskeyOptionsResponse>()(
        'post',
        '/account/passkeys/options',
    ),
    register: contract<
        typeof PasskeyRegisterInputSchema.inferIn,
        undefined,
        PasskeyRegisterResponse
    >()('post', '/account/passkeys'),
    rename: contract<typeof PasskeyRenameInputSchema.inferIn, undefined, PasskeyRenameResponse>()(
        'patch',
        '/account/passkeys/:id',
    ),
    remove: contract<undefined, undefined, PasskeyDeleteResponse>()(
        'delete',
        '/account/passkeys/:id',
    ),
}
