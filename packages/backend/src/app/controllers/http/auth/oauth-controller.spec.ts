import { Result } from 'better-result'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The OAuth callback is a browser navigation: every outcome must be a 302 back to the
// frontend, never an error status that leaves the user on a raw JSON page.

const { handleCallback, getConfiguredProviders } = vi.hoisted(() => ({
    handleCallback: vi.fn(),
    getConfiguredProviders: vi.fn(),
}))

vi.mock('#app/services/auth/oauth-service.js', () => ({
    OAUTH_EMAIL_UNVERIFIED: 'oauth_email_unverified',
    oauthService: { handleCallback, getConfiguredProviders },
}))
vi.mock('#config/oauth.js', () => ({
    default: {
        frontendSuccessUrl: '/?oauth=success',
        frontendErrorUrl: '/?error=oauth_failed',
    },
}))

const { default: OAuthController, withReason } = await import('./oauth-controller.js')

const createContext = (query: { code?: string; state?: string }, storedState = 'state-1') => {
    const headers = new Map<string, string>()
    return {
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        signal: new AbortController().signal,
        httpData: { params: { provider: 'google' }, query },
        responseData: {
            status: 200,
            setHeader: (name: string, value: string) => headers.set(name, value),
        },
        session: {
            sessionInfo: { id: 's1', data: { oauthState: storedState } },
            updateSessionData: vi.fn(),
        },
        auth: {},
        headers,
    } as never as Parameters<typeof OAuthController.callback>[0] & {
        headers: Map<string, string>
    }
}

describe('OAuthController.callback', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('redirects to the success URL after login', async () => {
        handleCallback.mockResolvedValue(Result.ok({ redirectUrl: '/?oauth=success' }))
        const context = createContext({ code: 'c', state: 'state-1' })

        await OAuthController.callback(context)

        expect(context.responseData.status).toBe(302)
        expect(context.headers.get('Location')).toBe('/?oauth=success')
    })

    it('redirects to the error URL when parameters are missing', async () => {
        const context = createContext({ state: 'state-1' })

        const response = await OAuthController.callback(context)

        expect(context.responseData.status).toBe(302)
        expect(context.headers.get('Location')).toBe('/?error=oauth_failed')
        expect(response).toEqual({
            status: 'error',
            code: 'bad_request',
            message: 'Missing OAuth parameters',
        })
        expect(handleCallback).not.toHaveBeenCalled()
    })

    it('keeps the 302 when the service fails', async () => {
        handleCallback.mockResolvedValue(
            Result.err({ _tag: 'BadRequest', message: 'OAuth state mismatch' }),
        )
        const context = createContext({ code: 'c', state: 'other' })

        await OAuthController.callback(context)

        expect(context.responseData.status).toBe(302)
        expect(context.headers.get('Location')).toBe('/?error=oauth_failed')
    })

    // feat-088: before, a 5xx in the callback only left a warn without the cause.
    it('logs a 5xx failure with its cause and still redirects', async () => {
        const cause = new Error('session store down')
        handleCallback.mockResolvedValue(
            Result.err({ _tag: 'Internal', publicMessage: 'Failed to log in user', cause }),
        )
        const context = createContext({ code: 'c', state: 'state-1' })

        await OAuthController.callback(context)

        expect(context.responseData.status).toBe(302)
        expect(context.headers.get('Location')).toBe('/?error=oauth_failed')
        expect(context.logger.error).toHaveBeenCalledWith(
            { err: cause, appError: 'Internal' },
            'Failed to log in user',
        )
    })

    // feat-090 (ADR 0004): the service now throws on an infrastructure failure; the
    // callback must still redirect, never answer a raw 500 JSON page.
    it('redirects to the error URL when the service throws, and logs the cause', async () => {
        const cause = new Error('database down')
        handleCallback.mockRejectedValue(cause)
        const context = createContext({ code: 'c', state: 'state-1' })

        await OAuthController.callback(context)

        expect(context.responseData.status).toBe(302)
        expect(context.headers.get('Location')).toBe('/?error=oauth_failed')
        expect(context.logger.error).toHaveBeenCalledWith(
            { err: cause, appError: 'Internal' },
            'OAuth sign-in failed',
        )
    })

    it('does not log a 4xx failure as error', async () => {
        handleCallback.mockResolvedValue(
            Result.err({ _tag: 'BadRequest', message: 'OAuth state mismatch' }),
        )
        const context = createContext({ code: 'c', state: 'other' })

        await OAuthController.callback(context)

        expect(context.logger.error).not.toHaveBeenCalled()
    })

    it('adds the reason when an existing account needs a verified email', async () => {
        handleCallback.mockResolvedValue(
            Result.err({
                _tag: 'Conflict',
                message: 'An account with this email already exists.',
                reason: 'oauth_email_unverified',
            }),
        )
        const context = createContext({ code: 'c', state: 'state-1' })

        await OAuthController.callback(context)

        expect(context.responseData.status).toBe(302)
        expect(context.headers.get('Location')).toBe(
            '/?error=oauth_failed&reason=oauth_email_unverified',
        )
    })
})

describe('OAuthController.providers', () => {
    it('returns the configured providers', () => {
        getConfiguredProviders.mockReturnValue(['google', 'github'])

        const response = OAuthController.providers()

        expect(response).toEqual({ status: 'ok', providers: ['google', 'github'] })
    })
})

describe('withReason', () => {
    it.each([
        ['/?error=oauth_failed', '/?error=oauth_failed&reason=r'],
        ['/login', '/login?reason=r'],
        ['/login?error=oauth_failed#login', '/login?error=oauth_failed&reason=r#login'],
        ['/login#login', '/login?reason=r#login'],
        [
            'https://app.example.com/login?error=oauth_failed#top',
            'https://app.example.com/login?error=oauth_failed&reason=r#top',
        ],
    ])('puts the reason into the query of %s', (url, expected) => {
        expect(withReason(url, 'r')).toBe(expected)
        expect(new URL(expected, 'https://app.example.com').searchParams.get('reason')).toBe('r')
    })

    it('leaves the URL untouched without a reason', () => {
        expect(withReason('/login?error=oauth_failed#login', null)).toBe(
            '/login?error=oauth_failed#login',
        )
    })
})
