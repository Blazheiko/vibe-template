import { type } from '@arktype/type'
import { CanonicalErrorResponseSchema } from './error-response.js'

// The redirect answers 302 or, for an unknown provider, the canonical error of
// mapControllerError (with `code`), which is checked at runtime.
export const OAuthRedirectResponseSchema = type.or(
    { status: "'redirect'" },
    CanonicalErrorResponseSchema,
)
export type OAuthRedirectResponse = typeof OAuthRedirectResponseSchema.infer

// The callback is always a 302 back to the frontend (not checked at runtime); the body
// marks the outcome with the canonical error shape, like every other route.
export const OAuthCallbackResponseSchema = type.or(
    { status: "'success'" },
    CanonicalErrorResponseSchema,
)
export type OAuthCallbackResponse = typeof OAuthCallbackResponseSchema.infer

// Providers whose client id, secret and redirect URI are all set on the backend.
export const OAuthProviderSchema = type.enumerated('google', 'facebook', 'github', 'gitlab')
export type OAuthProvider = typeof OAuthProviderSchema.infer

export const OAuthProvidersResponseSchema = type({
    status: "'ok'",
    providers: OAuthProviderSchema.array(),
})
export type OAuthProvidersResponse = typeof OAuthProvidersResponseSchema.infer

// feat-097: a mailed OAuth link confirmed in the browser that started the sign-in.
export const OAuthLinkConfirmResponseSchema = type.or(
    { status: "'success'" },
    CanonicalErrorResponseSchema,
)
export type OAuthLinkConfirmResponse = typeof OAuthLinkConfirmResponseSchema.infer

// feat-097: the link confirming the first address of an account, sent again.
export const EmailLinkResendResponseSchema = type.or(
    { status: "'success'", 'message?': 'string' },
    CanonicalErrorResponseSchema,
)
export type EmailLinkResendResponse = typeof EmailLinkResendResponseSchema.infer
