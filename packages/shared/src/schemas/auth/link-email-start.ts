import { type } from '@arktype/type'

// feat-245 (row 7 of Р3): allowed by a fresh step-up proof of the session.
export const LinkEmailStartInputSchema = type({
    email: 'string.email & string <= 255',
    '+': 'reject',
})

export type LinkEmailStartInput = typeof LinkEmailStartInputSchema.infer
