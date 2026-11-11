import { type } from '@arktype/type'

export const RegisterPhoneCompleteInputSchema = type({
    challengeId: 'string >= 8 & string <= 64',
    name: 'string >= 1 & string <= 100',
    password: 'string >= 8 & string <= 32',
    '+': 'reject',
})

export type RegisterPhoneCompleteInput = typeof RegisterPhoneCompleteInputSchema.infer
