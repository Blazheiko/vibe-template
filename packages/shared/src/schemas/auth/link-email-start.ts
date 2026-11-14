import { type } from '@arktype/type'
import { PasswordSchema } from './password.js'

export const LinkEmailStartInputSchema = type({
    email: 'string.email & string <= 255',
    currentPassword: PasswordSchema,
    '+': 'reject',
})

export type LinkEmailStartInput = typeof LinkEmailStartInputSchema.infer
