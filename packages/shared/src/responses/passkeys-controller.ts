import { type } from '@arktype/type'
import { EntityIdSchema } from '../brands/ids.js'
import { IsoDateTimeSchema } from '../brands/wire.js'
import { CanonicalErrorResponseSchema, type WithCanonicalError } from './error-response.js'

// feat-246 (docs/plan/passkeys-mfa-plan.md, Р6): the passkeys of the signed-in account.

export const PasskeySchema = type({
    id: EntityIdSchema,
    name: 'string',
    /** singleDevice or multiDevice (a synced passkey). */
    deviceType: 'string',
    backedUp: 'boolean',
    createdAt: IsoDateTimeSchema,
    lastUsedAt: IsoDateTimeSchema.or('null'),
})
export type Passkey = typeof PasskeySchema.infer

const CredentialDescriptorSchema = type({
    id: 'string',
    type: "'public-key'",
    'transports?': 'string[] | undefined',
})

/**
 * PublicKeyCredentialCreationOptionsJSON as @simplewebauthn/server makes it, handed to
 * @simplewebauthn/browser as it is. The library leaves unused optional fields as undefined.
 */
export const WebAuthnCreationOptionsSchema = type({
    challenge: 'string',
    rp: { name: 'string', 'id?': 'string | undefined' },
    user: { id: 'string', name: 'string', displayName: 'string' },
    pubKeyCredParams: type({ alg: 'number', type: "'public-key'" }).array(),
    'timeout?': 'number | undefined',
    'excludeCredentials?': CredentialDescriptorSchema.array().or('undefined'),
    'authenticatorSelection?': {
        'authenticatorAttachment?': 'string | undefined',
        'requireResidentKey?': 'boolean | undefined',
        'residentKey?': 'string | undefined',
        'userVerification?': 'string | undefined',
    },
    'hints?': 'string[] | undefined',
    'attestation?': 'string | undefined',
    'attestationFormats?': 'string[] | undefined',
    'extensions?': 'Record<string, unknown> | undefined',
})

export type WebAuthnCreationOptions = typeof WebAuthnCreationOptionsSchema.infer

/** PublicKeyCredentialRequestOptionsJSON: the options of a signature. */
export const WebAuthnRequestOptionsSchema = type({
    challenge: 'string',
    'timeout?': 'number | undefined',
    'rpId?': 'string | undefined',
    'allowCredentials?': CredentialDescriptorSchema.array().or('undefined'),
    'userVerification?': 'string | undefined',
    'hints?': 'string[] | undefined',
    'extensions?': 'Record<string, unknown> | undefined',
})

export type WebAuthnRequestOptions = typeof WebAuthnRequestOptionsSchema.infer

export const PasskeyOptionsResponseSchema = type.or(
    { status: "'success'", enrollmentId: 'string', options: WebAuthnCreationOptionsSchema },
    CanonicalErrorResponseSchema,
)
export type PasskeyOptionsResponse = WithCanonicalError<typeof PasskeyOptionsResponseSchema.infer>

export const PasskeyListResponseSchema = type.or(
    { status: "'success'", passkeys: PasskeySchema.array() },
    CanonicalErrorResponseSchema,
)
export type PasskeyListResponse = WithCanonicalError<typeof PasskeyListResponseSchema.infer>

export const PasskeyRegisterResponseSchema = type.or(
    { status: "'success'", passkey: PasskeySchema, recoveryCodes: type('string[]').or('null') },
    CanonicalErrorResponseSchema,
)
export type PasskeyRegisterResponse = WithCanonicalError<typeof PasskeyRegisterResponseSchema.infer>

export const PasskeyRenameResponseSchema = type.or(
    { status: "'success'", passkey: PasskeySchema },
    CanonicalErrorResponseSchema,
)
export type PasskeyRenameResponse = WithCanonicalError<typeof PasskeyRenameResponseSchema.infer>

export const PasskeyDeleteResponseSchema = type.or(
    { status: "'success'", mfaDisabled: 'boolean' },
    CanonicalErrorResponseSchema,
)
export type PasskeyDeleteResponse = WithCanonicalError<typeof PasskeyDeleteResponseSchema.infer>

/** feat-246: the options of a passwordless sign-in and the id the answer is sent back with. */
export const PasskeyLoginOptionsResponseSchema = type.or(
    { status: "'success'", challengeId: 'string', options: WebAuthnRequestOptionsSchema },
    CanonicalErrorResponseSchema,
)
export type PasskeyLoginOptionsResponse = WithCanonicalError<
    typeof PasskeyLoginOptionsResponseSchema.infer
>

/** feat-246: the options of a passkey signature for the second step or a step-up. */
export const PasskeyChallengeResponseSchema = type.or(
    { status: "'success'", options: WebAuthnRequestOptionsSchema },
    CanonicalErrorResponseSchema,
)
export type PasskeyChallengeResponse = WithCanonicalError<
    typeof PasskeyChallengeResponseSchema.infer
>
