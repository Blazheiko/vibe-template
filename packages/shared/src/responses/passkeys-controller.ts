import { type } from '@arktype/type'
import { CanonicalErrorResponseSchema, type WithCanonicalError } from './error-response.js'

// feat-246 (docs/plan/passkeys-mfa-plan.md, Р6): the passkeys of the signed-in account.

export const PasskeySchema = type({
    id: 'string',
    name: 'string',
    /** singleDevice or multiDevice (a synced passkey). */
    deviceType: 'string',
    backedUp: 'boolean',
    createdAt: 'string',
    lastUsedAt: 'string | null',
})
export type Passkey = typeof PasskeySchema.infer

/**
 * The WebAuthn options (PublicKeyCredentialCreationOptionsJSON or
 * PublicKeyCredentialRequestOptionsJSON) handed to @simplewebauthn/browser as they are.
 */
export const WebAuthnOptionsSchema = type({ challenge: 'string' }).and('object')

export const PasskeyOptionsResponseSchema = type.or(
    { status: "'success'", enrollmentId: 'string', options: WebAuthnOptionsSchema },
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
