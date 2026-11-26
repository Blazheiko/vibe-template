import { type } from '@arktype/type'
import { EntityIdSchema } from '../brands/ids.js'
import { IsoDateTimeSchema } from '../brands/wire.js'
import type { ErrorCode as AppErrorCode } from '../errors/error-codes.js'
import { RoleSchema } from '../access/role-schema.js'
import { CanonicalErrorResponseSchema, type CanonicalErrorResponse } from './error-response.js'

const AuthUserSchema = type({
    id: EntityIdSchema,
    name: 'string',
    'email?': 'string | null',
    'phone?': 'string | null',
    emailVerified: 'boolean',
    'emailVerifiedAt?': IsoDateTimeSchema.or('null'),
    'role?': RoleSchema,
    // The rest of userTransformer.serialize: the client keeps `avatar` from the login answer.
    'avatar?': 'string | null',
    'created_at?': 'string | null',
    'updated_at?': 'string | null',
})
/** The account as a sign-in, a registration or a contact change answers it (feat-268: the user store). */
export type AuthUser = typeof AuthUserSchema.infer

const PhoneChallengeResponseSchema = type.or(
    {
        status: "'success'",
        challengeId: 'string',
        expiresAt: IsoDateTimeSchema,
        resendAvailableAt: IsoDateTimeSchema,
    },
    CanonicalErrorResponseSchema,
)

const PhoneChallengeConfirmationResponseSchema = type.or(
    {
        status: "'success'",
        challengeId: 'string',
        verified: 'true',
    },
    CanonicalErrorResponseSchema,
)

export const RegisterResponseSchema = type.or(
    {
        status: "'success'",
        'message?': 'string',
        'user?': AuthUserSchema,
        'wsUrl?': 'string',
        'wsToken?': 'string',
        'csrfToken?': 'string',
    },
    CanonicalErrorResponseSchema,
)
export type RegisterResponse = typeof RegisterResponseSchema.infer

export const RegisterEmailResponseSchema = RegisterResponseSchema
export type RegisterEmailResponse = RegisterResponse

export const RegisterPhoneStartResponseSchema = PhoneChallengeResponseSchema
export type RegisterPhoneStartResponse = typeof RegisterPhoneStartResponseSchema.infer

export const RegisterPhoneConfirmResponseSchema = PhoneChallengeConfirmationResponseSchema
export type RegisterPhoneConfirmResponse = typeof RegisterPhoneConfirmResponseSchema.infer

export const RegisterPhoneCompleteResponseSchema = RegisterResponseSchema
export type RegisterPhoneCompleteResponse = RegisterResponse

export const LinkPhoneStartResponseSchema = PhoneChallengeResponseSchema
export type LinkPhoneStartResponse = typeof LinkPhoneStartResponseSchema.infer

export const LinkPhoneConfirmResponseSchema = type.or(
    {
        status: "'success'",
        'message?': 'string',
        'user?': AuthUserSchema,
    },
    CanonicalErrorResponseSchema,
)
export type LinkPhoneConfirmResponse = typeof LinkPhoneConfirmResponseSchema.infer

export const LinkEmailStartResponseSchema = type.or(
    {
        status: "'success'",
        'message?': 'string',
    },
    CanonicalErrorResponseSchema,
)
export type LinkEmailStartResponse = typeof LinkEmailStartResponseSchema.infer

export const ResetPhoneStartResponseSchema = type.or(
    {
        status: "'success'",
        'message?': 'string',
        'challengeId?': 'string',
        'expiresAt?': IsoDateTimeSchema,
        'resendAvailableAt?': IsoDateTimeSchema,
    },
    CanonicalErrorResponseSchema,
)
export type ResetPhoneStartResponse = typeof ResetPhoneStartResponseSchema.infer

export const ResetPhoneCompleteResponseSchema = type.or(
    { status: "'success'", 'message?': 'string', 'signInMethods?': 'string[]' },
    CanonicalErrorResponseSchema,
)
export type ResetPhoneCompleteResponse = typeof ResetPhoneCompleteResponseSchema.infer

export const LoginResponseSchema = type.or(
    {
        status: "'success'",
        'message?': 'string',
        'user?': AuthUserSchema,
        'wsUrl?': 'string',
        'wsToken?': 'string',
        'csrfToken?': 'string',
        /**
         * feat-245 (Р8): the created session is a recovery session (a recovery code, also when a
         * `continue` finished it): the client shows only the recovery wizard from the start, as
         * main/init says later. Absent for every other sign-in.
         */
        'recovery?': { expiresAt: IsoDateTimeSchema, replaced: 'boolean' },
    },
    // feat-245 (Р4): the first factor was right and the account has a second one; the second step
    // (POST /auth/mfa/verify) finishes the sign-in. The ticket travels in an HttpOnly cookie.
    {
        status: "'mfa_required'",
        methods: type.enumerated('totp', 'recovery_code', 'webauthn').array(),
        'csrfToken?': 'string',
    },
    CanonicalErrorResponseSchema,
)
export type LoginResponse = typeof LoginResponseSchema.infer

/**
 * feat-245 (Р4): POST /auth/mfa/state. The sign-in page, before a new sign-in, asks whether this
 * browser holds a second step (its ticket cookie, bound to this browser) that a reload took out of
 * memory. `completing`: a confirmed attempt is finishing; `{ method: 'continue' }` finishes it.
 * A missing, expired or foreign ticket is `none`, with nothing more.
 */
export const MfaStateResponseSchema = type.or(
    {
        status: "'mfa_required'",
        methods: type.enumerated('totp', 'recovery_code', 'webauthn').array(),
        'completing?': 'true',
    },
    { status: "'none'" },
    CanonicalErrorResponseSchema,
)
export type MfaStateResponse = typeof MfaStateResponseSchema.infer

export const LogoutResponseSchema = type.or(
    { status: "'success'", 'message?': 'string', csrfToken: 'string' },
    CanonicalErrorResponseSchema,
)
export type LogoutResponse = typeof LogoutResponseSchema.infer

export const LogoutAllResponseSchema = type.or(
    {
        status: "'success'",
        'message?': 'string',
        'deletedCount?': 'number',
        csrfToken: 'string',
    },
    CanonicalErrorResponseSchema,
)
export type LogoutAllResponse = typeof LogoutAllResponseSchema.infer

export const ChangePasswordResponseSchema = type.or(
    {
        status: "'success'",
        'message?': 'string',
        sessionRenewed: 'boolean',
        'csrfToken?': 'string',
        'wsUrl?': 'string',
        'wsToken?': 'string',
    },
    CanonicalErrorResponseSchema,
)
export type ChangePasswordResponse = typeof ChangePasswordResponseSchema.infer

const ForgotPasswordStatus = type.enumerated('success')
export const ForgotPasswordResponseSchema = type({
    status: ForgotPasswordStatus,
    'message?': 'string',
})
export type ForgotPasswordResponse = typeof ForgotPasswordResponseSchema.infer

type ResetPasswordReason =
    'invalid_token' | 'expired_token' | 'used_token' | 'token_required' | 'passwords_mismatch'
// The canonical error already accepts `reason: string`; a second error branch with the
// ResetPasswordReason enum would overlap it, and an overlapping union cannot get the
// undeclared-key strip (feat-046). The exact reason stays in ResetPasswordResponse.
export const ResetPasswordResponseSchema = type.or(
    {
        status: "'success'",
        'message?': 'string',
        // feat-199: the OAuth providers still linked to the account after the reset.
        'signInMethods?': 'string[]',
    },
    CanonicalErrorResponseSchema,
)
export type ResetPasswordResponse =
    | { status: 'success'; message?: string; signInMethods?: string[] }
    | CanonicalErrorResponse
    | {
          status: 'error'
          code: AppErrorCode
          message: string
          reason: ResetPasswordReason
          details?: unknown
      }

export const VerifyEmailResponseSchema = type.or(
    { status: "'success'", 'message?': 'string' },
    CanonicalErrorResponseSchema,
)
export type VerifyEmailResponse = typeof VerifyEmailResponseSchema.infer

export const ResendVerificationEmailResponseSchema = type.or(
    { status: "'success'", 'message?': 'string' },
    CanonicalErrorResponseSchema,
)
export type ResendVerificationEmailResponse = typeof ResendVerificationEmailResponseSchema.infer

// feat-199: the sign-in methods linked to the account (identities of OAuth providers).
const SignInMethodSchema = type({
    id: EntityIdSchema,
    provider: 'string',
    /** The profile name the provider reported, when it is safe to show; null otherwise. */
    name: 'string | null',
    linkedAt: IsoDateTimeSchema,
})
export const GetSignInMethodsResponseSchema = type.or(
    {
        status: "'success'",
        /** True: unlinking asks for the current password. False: for a recent sign-in. */
        hasPassword: 'boolean',
        methods: SignInMethodSchema.array(),
    },
    CanonicalErrorResponseSchema,
)
export type GetSignInMethodsResponse = typeof GetSignInMethodsResponseSchema.infer

export const UnlinkSignInMethodResponseSchema = type.or(
    { status: "'success'", 'message?': 'string' },
    CanonicalErrorResponseSchema,
)
export type UnlinkSignInMethodResponse = typeof UnlinkSignInMethodResponseSchema.infer
