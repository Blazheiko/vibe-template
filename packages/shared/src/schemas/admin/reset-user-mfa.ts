import { type } from '@arktype/type'

// feat-247 (docs/plan/passkeys-mfa-plan.md, Р13): an administrator resets the second factors of
// another account; the reason goes to the audit log.
export const ResetUserMfaInputSchema = type({
    reason: 'string >= 3 & string <= 200',
    '+': 'reject',
})

export type ResetUserMfaInput = typeof ResetUserMfaInputSchema.infer
