import { type } from '@arktype/type'

// One shape: `identifier` is an email or a phone number. The former `email` variant was a
// compatibility alias for older clients and is gone (feat-093).
export const LoginInputSchema = type({
    identifier: 'string >= 3 & string <= 255',
    password: 'string >= 8 & string <= 32',
    '+': 'reject',
})

export type LoginInput = typeof LoginInputSchema.infer
