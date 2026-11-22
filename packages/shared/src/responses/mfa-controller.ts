import { type } from '@arktype/type'
import { CanonicalErrorResponseSchema, type WithCanonicalError } from './error-response.js'

// feat-245 (docs/plan/passkeys-mfa-plan.md, Р7, Р8, Р15): the sign-in security section.

const ProofMethodSchema = type.enumerated('password', 'totp', 'webauthn')

export const MfaStatusResponseSchema = type.or(
    {
        status: "'success'",
        totp: { enabled: 'boolean', createdAt: 'string | null' },
        passkeys: 'number.integer >= 0',
        recoveryCodesRemaining: 'number.integer >= 0',
        /** A verified email (or phone with phone auth on): the first factor needs it (Р12). */
        recoveryContact: 'boolean',
        /** The proofs POST /auth/reauth accepts from this account. */
        stepUpProofs: ProofMethodSchema.array(),
        /** Set in a recovery session (Р8). */
        recovery: type({ expiresAt: 'string', replaced: 'boolean' }).or('null'),
    },
    CanonicalErrorResponseSchema,
)
export type MfaStatusResponse = WithCanonicalError<typeof MfaStatusResponseSchema.infer>

export const TotpSetupResponseSchema = type.or(
    {
        status: "'success'",
        enrollmentId: 'string',
        /** base32, for typing it in by hand. */
        secret: 'string',
        /** What the QR code carries; drawn by the client. */
        otpauthUri: 'string',
    },
    CanonicalErrorResponseSchema,
)
export type TotpSetupResponse = WithCanonicalError<typeof TotpSetupResponseSchema.infer>

/** The codes are shown once: null when this confirmation issued none. */
export const TotpConfirmResponseSchema = type.or(
    { status: "'success'", recoveryCodes: type('string[]').or('null') },
    CanonicalErrorResponseSchema,
)
export type TotpConfirmResponse = WithCanonicalError<typeof TotpConfirmResponseSchema.infer>

export const TotpDisableResponseSchema = type.or(
    { status: "'success'", mfaDisabled: 'boolean' },
    CanonicalErrorResponseSchema,
)
export type TotpDisableResponse = WithCanonicalError<typeof TotpDisableResponseSchema.infer>

export const RecoveryCodesResponseSchema = type.or(
    { status: "'success'", recoveryCodes: 'string[]' },
    CanonicalErrorResponseSchema,
)
export type RecoveryCodesResponse = WithCanonicalError<typeof RecoveryCodesResponseSchema.infer>
