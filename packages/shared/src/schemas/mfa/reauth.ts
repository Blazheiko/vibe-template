import { type } from '@arktype/type'
import { PasswordSchema } from '../auth/password.js'
import { AuthenticationResponseSchema } from '../passkeys/webauthn-response.js'

// feat-245 (docs/plan/passkeys-mfa-plan.md, Р3): a step-up proof of the signed-in session. The
// matrix decides which proofs an action accepts; this records that one was given now. feat-246:
// a passkey answers the options of POST /auth/reauth/webauthn/options.
export const ReauthInputSchema = type({
    proof: "'password' | 'totp' | 'webauthn'",
    'password?': PasswordSchema,
    'code?': 'string >= 6 & string <= 10',
    'response?': AuthenticationResponseSchema,
    '+': 'reject',
})

export type ReauthInput = typeof ReauthInputSchema.infer
