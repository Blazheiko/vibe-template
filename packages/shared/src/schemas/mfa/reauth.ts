import { type } from '@arktype/type'
import { PasswordSchema } from '../auth/password.js'

// feat-245 (docs/plan/passkeys-mfa-plan.md, Р3): a step-up proof of the signed-in session. The
// matrix decides which proofs an action accepts; this records that one was given now.
export const ReauthInputSchema = type({
    proof: "'password' | 'totp'",
    'password?': PasswordSchema,
    'code?': 'string >= 6 & string <= 10',
    '+': 'reject',
})

export type ReauthInput = typeof ReauthInputSchema.infer
