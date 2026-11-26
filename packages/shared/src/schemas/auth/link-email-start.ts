import { type } from '@arktype/type'
import { EmailInputSchema } from './email.js'

// feat-245 (row 7 of Р3): allowed by a fresh step-up proof of the session.
export const LinkEmailStartInputSchema = type({
    email: EmailInputSchema,
    '+': 'reject',
})

export type LinkEmailStartInput = typeof LinkEmailStartInputSchema.infer
