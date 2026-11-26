import { type } from '@arktype/type'
import { EmailInputSchema } from './email.js'
import { PasswordSchema } from './password.js'

export const RegisterEmailInputSchema = type({
    name: 'string >= 1 & string <= 100',
    email: EmailInputSchema,
    password: PasswordSchema,
    '+': 'reject',
})

export type RegisterEmailInput = typeof RegisterEmailInputSchema.infer
