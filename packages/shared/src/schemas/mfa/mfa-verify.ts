import { type } from '@arktype/type'

// feat-245 (docs/plan/passkeys-mfa-plan.md, Р4): the second sign-in step. A repeat of the same
// request finishes a sign-in an earlier one confirmed.
export const MfaVerifyInputSchema = type({
    method: "'totp' | 'recovery_code'",
    code: 'string >= 6 & string <= 64',
    '+': 'reject',
})

export type MfaVerifyInput = typeof MfaVerifyInputSchema.infer
