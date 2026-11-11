import type { OAuthLinkConfirmInputSchema } from '../schemas/auth/oauth-link-confirm.js'
import type {
    EmailLinkResendResponse,
    OAuthLinkConfirmResponse,
    OAuthProvidersResponse,
} from '../responses/oauth-controller.js'
import { contract } from './core.js'

// The JSON routes of OAuth. The provider redirect and the callback answer with a redirect, not
// JSON, and get their contracts with the other non-JSON routes (feat-177).
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
} as const
