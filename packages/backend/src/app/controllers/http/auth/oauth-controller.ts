import type { HttpContext } from '#vendor/types/types.js'
import type { ParamsOf } from '#app/routing/contract-registry.js'
import type { oauthContracts } from 'shared/contracts'
import {
    mapControllerError,
    reportControllerError,
    respond,
} from '#app/controllers/shared/controller-error.js'
import { Result } from 'better-result'
import {
    EMAIL_CHANGED,
    OAUTH_ALREADY_LINKED,
    OAUTH_LINK_REVOKED,
    oauthService,
    TOO_MANY_ATTEMPTS,
} from '#app/services/auth/oauth-service.js'
import { getTypedPayload } from '#vendor/utils/validation/get-typed-payload.js'
import { requireUserId } from '#app/controllers/shared/require-user-id.js'
import {
    appErrorMessage,
    badRequest,
    internal,
    sessionRevoked,
    unauthorized,
    type AppError,
} from '#app/services/shared/errors.js'
import { appErrorToPayload } from '#app/services/shared/app-error-payload.js'
import type { OAuthCallbackQuery, OAuthLinkConfirmInput, OAuthRedirectQuery } from 'shared/schemas'
import oauthConfig from '#config/oauth.js'
import { safeEqual } from '#vendor/utils/helpers/safe-equal.js'
import type {
    EmailLinkResendResponse,
    OAuthCallbackResponse,
    OAuthLinkConfirmResponse,
    OAuthProvidersResponse,
    OAuthRedirectResponse,
} from 'shared'

// The reasons the frontend explains to the user (feat-097); any other error is generic.
const REDIRECT_REASONS = [
    OAUTH_LINK_REVOKED,
    EMAIL_CHANGED,
    OAUTH_ALREADY_LINKED,
    TOO_MANY_ATTEMPTS,
] as const

// The callback is a browser navigation, so every outcome must be a redirect back to
// the frontend: an error status would leave the user on a raw JSON page.
const redirectToError = (
    context: HttpContext<unknown, OAuthCallbackQuery>,
    error: AppError,
): OAuthCallbackResponse => {
    context.logger.warn({ error: appErrorMessage(error) }, 'oauth callback failed')
    // A 5xx (database, session store) also goes to the log with its cause and to Sentry.
    reportControllerError(context, error)
    const reason =
        'reason' in error &&
        typeof error.reason === 'string' &&
        (REDIRECT_REASONS as readonly string[]).includes(error.reason)
            ? error.reason
            : null
    context.responseData.status = 302
    context.responseData.setHeader('Location', withReason(oauthConfig.frontendErrorUrl, reason))
    // The status stays 302: only the body takes the canonical error shape.
    return appErrorToPayload(error)
}

// Adds `reason=<code>` to the query of the configured error URL, which may be relative
// or absolute. The parameter goes before any `#fragment`, or the frontend would not see it.
export const withReason = (url: string, reason: string | null): string => {
    if (reason === null) return url
    const hashIndex = url.indexOf('#')
    const base = hashIndex === -1 ? url : url.slice(0, hashIndex)
    const fragment = hashIndex === -1 ? '' : url.slice(hashIndex)
    const separator = base.includes('?') ? '&' : '?'
    return `${base}${separator}reason=${encodeURIComponent(reason)}${fragment}`
}

export default {
    providers(): OAuthProvidersResponse {
        return { status: 'ok', providers: oauthService.getConfiguredProviders() }
    },

    async redirect(
        context: HttpContext<unknown, OAuthRedirectQuery, ParamsOf<typeof oauthContracts.redirect>>,
    ): Promise<OAuthRedirectResponse> {
        const provider = context.httpData.params.provider

        const result = oauthService.getAuthorizationUrl(provider)

        if (Result.isError(result)) {
            return mapControllerError(context, result.error)
        }

        // The URL carries the single-use state and the PKCE challenge: the log names the
        // provider only (feat-150).
        context.logger.info({ provider }, 'oauth redirect to the provider')

        // Store OAuth state and PKCE verifier in session. feat-111: a session that vanished
        // meanwhile (a logout in another tab) is not recreated; the sign-in stops here instead of
        // sending the browser to the provider with a state the callback can never match.
        const stored = await context.session.updateSessionData({
            oauthState: result.value.state,
            oauthCodeVerifier: result.value.codeVerifier,
        })
        if (stored === null) {
            return mapControllerError(context, sessionRevoked())
        }

        context.responseData.status = 302
        context.responseData.setHeader('Location', result.value.url)

        return { status: 'redirect' }
    },

    async callback(
        context: HttpContext<unknown, OAuthCallbackQuery, ParamsOf<typeof oauthContracts.callback>>,
    ): Promise<OAuthCallbackResponse> {
        const { httpData, logger, session, responseData, auth } = context
        const provider = httpData.params.provider
        const query = httpData.query
        const code = query.code ?? ''
        const receivedState = query.state ?? ''

        logger.info(
            { provider, hasCode: code !== '', hasState: receivedState !== '' },
            'oauth callback handler',
        )

        const sessionData = session.sessionInfo?.data
        const storedState =
            typeof sessionData?.['oauthState'] === 'string' ? sessionData['oauthState'] : ''
        const codeVerifier =
            typeof sessionData?.['oauthCodeVerifier'] === 'string'
                ? sessionData['oauthCodeVerifier']
                : null

        if (code === '' || receivedState === '' || storedState === '') {
            return redirectToError(context, badRequest('Missing OAuth parameters'))
        }

        // feat-123: compared before it is consumed. A navigation another site makes to this
        // callback with a made-up state must not use up the state of a sign-in the user is in the
        // middle of (SameSite=Lax sends the cookie on such a navigation).
        if (!safeEqual(storedState, receivedState)) {
            return redirectToError(context, badRequest('OAuth state mismatch'))
        }

        // feat-119 (F2): the state and verifier are single-use and are consumed BEFORE anything
        // happens on their behalf (accounts, mail, the login), and only while the session still
        // holds the state this request read. One compare-and-set decides:
        // - gone: a logout deleted the session after it was read; nobody is signed in;
        // - mismatch: another callback with the same state won, or a new OAuth start replaced it;
        //   this callback stops and the newer state stays;
        // - consumed: this callback is the only one that goes on.
        let consumed: Awaited<ReturnType<typeof session.consumeSessionData>>
        try {
            consumed = await session.consumeSessionData({ oauthState: storedState }, [
                'oauthState',
                'oauthCodeVerifier',
            ])
        } catch (err: unknown) {
            return redirectToError(context, internal(err, 'OAuth state could not be consumed'))
        }
        if (consumed === 'gone') {
            return redirectToError(context, sessionRevoked())
        }
        if (consumed === 'mismatch') {
            return redirectToError(context, badRequest('OAuth state was already used or replaced'))
        }

        let result: Awaited<ReturnType<typeof oauthService.handleCallback>>
        try {
            result = await oauthService.handleCallback(
                provider,
                code,
                storedState,
                receivedState,
                codeVerifier,
                auth,
                session.sessionInfo?.id ?? null,
            )
        } catch (err: unknown) {
            // ADR 0004: an infrastructure failure throws, but this is a browser navigation:
            // it still ends in the error redirect (redirectToError logs it with the cause).
            result = Result.err(internal(err, 'OAuth sign-in failed'))
        }

        if (Result.isError(result)) {
            return redirectToError(context, result.error)
        }

        responseData.status = 302
        responseData.setHeader('Location', result.value.redirectUrl)

        return { status: 'success' }
    },

    /** feat-097: the mailed link that confirms an OAuth link, opened in the same browser. */
    async confirmLink(
        context: HttpContext<OAuthLinkConfirmInput>,
    ): Promise<OAuthLinkConfirmResponse> {
        const payload = getTypedPayload(context)
        const result = await oauthService.confirmLink(
            payload.token,
            context.auth,
            context.session.sessionInfo?.id ?? null,
        )
        return respond(context, result)
    },

    /** feat-097: the link that confirms the first address of an account, sent again. */
    async resendEmailLink(context: HttpContext): Promise<EmailLinkResendResponse> {
        const userId = requireUserId(context)
        if (userId === null) {
            return mapControllerError(context, unauthorized())
        }
        const result = await oauthService.resendFirstEmailLink(
            userId,
            context.auth.getPresentedUserToken(),
            () => context.session.isStored(),
        )
        return respond(context, result, (value) => ({ status: 'success', message: value.message }))
    },
}
