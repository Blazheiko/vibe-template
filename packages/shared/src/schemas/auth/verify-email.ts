import { type } from '@arktype/type'

export const VerifyEmailInputSchema = type({
    token: 'string >= 1 & string <= 255',
    // feat-097: a registration link confirms the account only with its password (or from a
    // session of that account), so a link clicked by somebody who did not register does
    // nothing. Length bounds as in login.
    'password?': 'string >= 1 & string <= 32',
    '+': 'reject',
})

export type VerifyEmailInput = typeof VerifyEmailInputSchema.infer
