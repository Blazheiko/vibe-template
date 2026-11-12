import { type } from '@arktype/type'
import { PasswordSchema } from './password.js'

export const ChangePasswordInputSchema = type({
    'currentPassword?': PasswordSchema,
    newPassword: PasswordSchema,
    '+': 'reject',
})

export type ChangePasswordInput = typeof ChangePasswordInputSchema.infer
