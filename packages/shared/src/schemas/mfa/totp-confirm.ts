import { type } from '@arktype/type'

// feat-245 (docs/plan/passkeys-mfa-plan.md, Р7): the confirmation of a TOTP setup.
export const TotpConfirmInputSchema = type({
    enrollmentId: 'string >= 1 & string <= 32',
    code: 'string >= 6 & string <= 10',
    '+': 'reject',
})

export type TotpConfirmInput = typeof TotpConfirmInputSchema.infer
