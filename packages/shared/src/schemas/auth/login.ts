import { type } from '@arktype/type'

const LegacyLoginInputSchema = type({
    email: 'string.email & string <= 255',
    password: 'string >= 8 & string <= 32',
    'token?': 'string <= 60',
    '+': 'reject',
})

const IdentifierLoginInputSchema = type({
    identifier: 'string >= 3 & string <= 255',
    password: 'string >= 8 & string <= 32',
    'token?': 'string <= 60',
    '+': 'reject',
})

export const LoginInputSchema = type.or(LegacyLoginInputSchema, IdentifierLoginInputSchema)

export type LoginInput = typeof LoginInputSchema.infer
