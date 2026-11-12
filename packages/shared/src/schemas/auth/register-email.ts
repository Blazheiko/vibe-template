import { type } from '@arktype/type'
import { PasswordSchema } from './password.js'

export const RegisterEmailInputSchema = type({
    name: 'string >= 1 & string <= 100',
    email: 'string.email & string <= 255',
    password: PasswordSchema,
    '+': 'reject',
})

export type RegisterEmailInput = typeof RegisterEmailInputSchema.infer
