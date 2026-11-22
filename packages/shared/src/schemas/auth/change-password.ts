import { type } from '@arktype/type'
import { PasswordSchema } from './password.js'

// feat-245 (row 6 of Р3): the change is allowed by a fresh step-up proof of the session
// (POST /auth/reauth), not by a password typed into this form.
export const ChangePasswordInputSchema = type({
    newPassword: PasswordSchema,
    '+': 'reject',
})

export type ChangePasswordInput = typeof ChangePasswordInputSchema.infer
