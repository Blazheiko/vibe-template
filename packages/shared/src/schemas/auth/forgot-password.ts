import { type } from '@arktype/type'
import { EmailInputSchema } from './email.js'

export const ForgotPasswordInputSchema = type({
    email: EmailInputSchema,
    '+': 'reject',
})

export type ForgotPasswordInput = typeof ForgotPasswordInputSchema.infer
