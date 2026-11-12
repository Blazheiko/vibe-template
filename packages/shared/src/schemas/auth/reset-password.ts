import { type } from '@arktype/type'
import { PasswordSchema } from './password.js'

export const ResetPasswordInputSchema = type({
    token: 'string >= 1 & string <= 255',
    password: PasswordSchema,
    passwordConfirm: PasswordSchema,
    '+': 'reject',
})

export type ResetPasswordInput = typeof ResetPasswordInputSchema.infer
