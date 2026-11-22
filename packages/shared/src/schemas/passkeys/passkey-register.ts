import { type } from '@arktype/type'

import { AuthenticationResponseSchema, RegistrationResponseSchema } from './webauthn-response.js'

// feat-246 (docs/plan/passkeys-mfa-plan.md, Р6): the answer of the authenticator to the options
// of POST /account/passkeys/options, with the enrollment those options opened.
export const PasskeyRegisterInputSchema = type({
    enrollmentId: 'string >= 1 & string <= 32',
    'name?': 'string <= 64',
    response: RegistrationResponseSchema,
    '+': 'reject',
})
export type PasskeyRegisterInput = typeof PasskeyRegisterInputSchema.infer

export const PasskeyRenameInputSchema = type({
    name: 'string >= 1 & string <= 64',
    '+': 'reject',
})
export type PasskeyRenameInput = typeof PasskeyRenameInputSchema.infer

// feat-246 (Р6): the answer to the options of a passwordless sign-in.
export const PasskeyLoginInputSchema = type({
    challengeId: 'string >= 1 & string <= 64',
    response: AuthenticationResponseSchema,
    '+': 'reject',
})
export type PasskeyLoginInput = typeof PasskeyLoginInputSchema.infer
