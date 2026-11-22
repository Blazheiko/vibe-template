import { type } from '@arktype/type'

// feat-245 (row 7 of Р3): allowed by a fresh step-up proof of the session.
export const LinkPhoneStartInputSchema = type({
    phone: 'string >= 6 & string <= 32',
    'defaultCountry?': 'string == 2',
    '+': 'reject',
})

export type LinkPhoneStartInput = typeof LinkPhoneStartInputSchema.infer
