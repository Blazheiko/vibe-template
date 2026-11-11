import type { OAuthLinkConfirmInputSchema } from '../schemas/auth/oauth-link-confirm.js'
import type { OAuthCallbackQueryInput, OAuthRedirectQueryInput } from '../schemas/query/simple.js'
import type {
    EmailLinkResendResponse,
    OAuthCallbackResponse,
    OAuthLinkConfirmResponse,
    OAuthProvidersResponse,
    OAuthRedirectResponse,
} from '../responses/oauth-controller.js'
import { contract, navigationContract } from './core.js'

// OAuth: three JSON routes and two the browser navigates through (a 302 to the provider, and the
// provider's 302 back to the callback, which ends with a 302 to the frontend).
export const oauthContracts = {
    providers: contract<undefined, undefined, OAuthProvidersResponse>()(
        'get',
        '/auth/oauth/providers',
    ),
    // feat-097: the mailed link that confirms an OAuth link.
    confirmLink: contract<
        typeof OAuthLinkConfirmInputSchema.inferIn,
        undefined,
        OAuthLinkConfirmResponse
    >()('post', '/auth/oauth/link/confirm'),
    // feat-097: the link that confirms the address of an account without one, sent again. The
    // route reads no body.
    resendEmailLink: contract<undefined, undefined, EmailLinkResendResponse>()(
        'post',
        '/auth/oauth/email/resend',
    ),
    redirect: navigationContract<OAuthRedirectQueryInput, OAuthRedirectResponse>()(
        '/auth/oauth/:provider/redirect',
    ),
    // The provider calls it; the query is the provider's (`code`, `state`, and more).
    callback: navigationContract<OAuthCallbackQueryInput, OAuthCallbackResponse>()(
        '/auth/oauth/:provider/callback',
    ),
} as const
