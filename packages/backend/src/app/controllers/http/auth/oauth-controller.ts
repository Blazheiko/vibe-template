import type { HttpContext } from '#vendor/types/types.js'
import {
    mapControllerError,
    reportControllerError,
} from '#app/controllers/shared/controller-error.js'
import { Result } from 'better-result'
import { OAUTH_EMAIL_UNVERIFIED, oauthService } from '#app/services/auth/oauth-service.js'
import {
    appErrorMessage,
    badRequest,
    internal,
    type AppError,
} from '#app/services/shared/errors.js'
import { appErrorToPayload } from '#app/services/shared/app-error-payload.js'
import type { OAuthCallbackQuery, OAuthRedirectQuery } from 'shared/schemas'
import oauthConfig from '#config/oauth.js'
import type { OAuthCallbackResponse, OAuthProvidersResponse, OAuthRedirectResponse } from 'shared'

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
        'reason' in error && error.reason === OAUTH_EMAIL_UNVERIFIED ? OAUTH_EMAIL_UNVERIFIED : null
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
        context: HttpContext<unknown, OAuthRedirectQuery>,
    ): Promise<OAuthRedirectResponse> {
        const provider = context.httpData.params['provider'] ?? ''

        const result = oauthService.getAuthorizationUrl(provider)

        if (Result.isError(result)) {
            return mapControllerError(context, result.error)
        }

        context.logger.info({ url: result.value.url }, 'oauth generated URL')

        // Store OAuth state and PKCE verifier in session.
        await context.session.updateSessionData({
            oauthState: result.value.state,
            oauthCodeVerifier: result.value.codeVerifier,
        })

        context.responseData.status = 302
        context.responseData.setHeader('Location', result.value.url)

        return { status: 'redirect' }
    },

    async callback(
        context: HttpContext<unknown, OAuthCallbackQuery>,
    ): Promise<OAuthCallbackResponse> {
        const { httpData, logger, session, responseData, auth } = context
        const provider = httpData.params['provider'] ?? ''
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

        let result: Awaited<ReturnType<typeof oauthService.handleCallback>>
        try {
            result = await oauthService.handleCallback(
                provider,
                code,
                storedState,
                receivedState,
                codeVerifier,
                auth,
            )
        } catch (err: unknown) {
            // ADR 0004: an infrastructure failure throws, but this is a browser navigation:
            // it still ends in the error redirect (redirectToError logs it with the cause).
            result = Result.err(internal(err, 'OAuth sign-in failed'))
        }

        // Clean up OAuth session data
        await session.updateSessionData({
            oauthState: undefined,
            oauthCodeVerifier: undefined,
        })

        if (Result.isError(result)) {
            return redirectToError(context, result.error)
        }

        responseData.status = 302
        responseData.setHeader('Location', result.value.redirectUrl)

        return { status: 'success' }
    },
}
