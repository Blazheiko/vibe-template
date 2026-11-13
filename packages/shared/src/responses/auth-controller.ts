import { type } from '@arktype/type'
import type { ErrorCode as AppErrorCode } from '../errors/error-codes.js'
import { CanonicalErrorResponseSchema, type CanonicalErrorResponse } from './error-response.js'

const AuthUserSchema = type({
    id: 'string',
    name: 'string',
    'email?': 'string | null',
    'phone?': 'string | null',
    emailVerified: 'boolean',
    'emailVerifiedAt?': 'string | null',
    'role?': "'user' | 'admin'",
    // The rest of userTransformer.serialize: the client keeps `avatar` from the login answer.
    'avatar?': 'string | null',
    'created_at?': 'string | null',
    'updated_at?': 'string | null',
})

const PhoneChallengeResponseSchema = type.or(
    {
        status: "'success'",
        challengeId: 'string',
        expiresAt: 'string',
        resendAvailableAt: 'string',
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
        'expiresAt?': 'string',
        'resendAvailableAt?': 'string',
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
    },
    CanonicalErrorResponseSchema,
)
export type LoginResponse = typeof LoginResponseSchema.infer

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
    id: 'string',
    provider: 'string',
    /** The profile name the provider reported, when it is safe to show; null otherwise. */
    name: 'string | null',
    linkedAt: 'string',
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
