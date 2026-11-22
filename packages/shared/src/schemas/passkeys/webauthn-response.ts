import { type } from '@arktype/type'

// feat-246 (docs/plan/passkeys-mfa-plan.md, Р6): what a browser answers to a WebAuthn ceremony,
// as @simplewebauthn/browser serialises it (base64url strings). The server checks the content;
// these schemas only bound its shape and size.

const base64url = 'string >= 1 & string <= 16384'

export const RegistrationResponseSchema = type({
    id: 'string >= 1 & string <= 1024',
    rawId: 'string >= 1 & string <= 1024',
    type: "'public-key'",
    response: {
        clientDataJSON: base64url,
        attestationObject: base64url,
        'authenticatorData?': base64url,
        'transports?': 'string[] <= 8',
        'publicKeyAlgorithm?': 'number.integer',
        'publicKey?': base64url,
    },
    clientExtensionResults: 'object',
    'authenticatorAttachment?': "'platform' | 'cross-platform'",
})
export type RegistrationResponse = typeof RegistrationResponseSchema.infer

export const AuthenticationResponseSchema = type({
    id: 'string >= 1 & string <= 1024',
    rawId: 'string >= 1 & string <= 1024',
    type: "'public-key'",
    response: {
        clientDataJSON: base64url,
        authenticatorData: base64url,
        signature: base64url,
        'userHandle?': 'string <= 1024',
    },
    clientExtensionResults: 'object',
    'authenticatorAttachment?': "'platform' | 'cross-platform'",
})
export type AuthenticationResponse = typeof AuthenticationResponseSchema.infer
