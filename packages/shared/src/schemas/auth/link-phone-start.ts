import { type } from '@arktype/type'
import { PasswordSchema } from './password.js'

export const LinkPhoneStartInputSchema = type({
    phone: 'string >= 6 & string <= 32',
    currentPassword: PasswordSchema,
    'defaultCountry?': 'string == 2',
    '+': 'reject',
})

export type LinkPhoneStartInput = typeof LinkPhoneStartInputSchema.infer
