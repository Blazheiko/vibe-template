import { type } from '@arktype/type'
import { PasswordSchema } from './password.js'

export const ResetPhoneCompleteInputSchema = type({
    challengeId: 'string >= 1 & string <= 64',
    code: 'string >= 4 & string <= 12',
    password: PasswordSchema,
    passwordConfirm: PasswordSchema,
    '+': 'reject',
})

export type ResetPhoneCompleteInput = typeof ResetPhoneCompleteInputSchema.infer
