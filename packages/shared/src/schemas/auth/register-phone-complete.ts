import { type } from '@arktype/type'
import { PasswordSchema } from './password.js'

export const RegisterPhoneCompleteInputSchema = type({
    challengeId: 'string >= 8 & string <= 64',
    name: 'string >= 1 & string <= 100',
    password: PasswordSchema,
    '+': 'reject',
})

export type RegisterPhoneCompleteInput = typeof RegisterPhoneCompleteInputSchema.infer
