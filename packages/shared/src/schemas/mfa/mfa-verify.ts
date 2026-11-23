import { type } from '@arktype/type'

import { AuthenticationResponseSchema } from '../passkeys/webauthn-response.js'

// feat-245 (docs/plan/passkeys-mfa-plan.md, Р4): the second sign-in step. A repeat of the same
// request finishes a sign-in an earlier one confirmed. feat-246: a passkey answers the options of
// POST /auth/mfa/webauthn/options instead of a code. `continue` carries no proof: it only finishes a
// sign-in this browser's ticket already confirmed (its answer was lost or the page reloaded).
export const MfaVerifyInputSchema = type({
    method: "'totp' | 'recovery_code'",
    code: 'string >= 6 & string <= 64',
    '+': 'reject',
})
    .or({
        method: "'webauthn'",
        response: AuthenticationResponseSchema,
        '+': 'reject',
    })
    .or({
        method: "'continue'",
        '+': 'reject',
    })

export type MfaVerifyInput = typeof MfaVerifyInputSchema.infer
