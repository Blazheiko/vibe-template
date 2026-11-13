import { Result } from 'better-result'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The OAuth callback is a browser navigation: every outcome must be a 302 back to the
// frontend, never an error status that leaves the user on a raw JSON page.

const {
    handleCallback,
    getConfiguredProviders,
    confirmLink,
    resendFirstEmailLink,
    getAuthorizationUrl,
} = vi.hoisted(() => ({
    getAuthorizationUrl: vi.fn(),
    handleCallback: vi.fn(),
    getConfiguredProviders: vi.fn(),
    confirmLink: vi.fn(),
    resendFirstEmailLink: vi.fn(),
}))

vi.mock('#app/services/auth/oauth-service.js', () => ({
    OAUTH_LINK_REVOKED: 'oauth_link_revoked',
    EMAIL_CHANGED: 'email_changed',
    OAUTH_ALREADY_LINKED: 'oauth_already_linked',
    OAUTH_CROSS_SITE_START: 'oauth_cross_site_start',
    TOO_MANY_ATTEMPTS: 'too_many_attempts',
    oauthService: {
        handleCallback,
        getConfiguredProviders,
        confirmLink,
        resendFirstEmailLink,
        getAuthorizationUrl,
    },
}))
vi.mock('#config/oauth.js', () => ({
    default: {
        frontendSuccessUrl: '/?oauth=success',
        frontendErrorUrl: '/?error=oauth_failed',
    },
}))

const { default: OAuthController, withReason } = await import('./oauth-controller.js')

const createContext = (
    query: { code?: string; state?: string },
    storedState = 'state-1',
    // The provider the stored state was issued for (feat-200), and the request's headers.
    storedProvider = 'google',
    requestHeaders: Record<string, string> = {},
) => {
    const headers = new Map<string, string>()
    return {
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        signal: new AbortController().signal,
        httpData: {
            params: { provider: 'google' },
            query,
            headers: new Map(Object.entries(requestHeaders)),
        },
        responseData: {
            status: 200,
            setHeader: (name: string, value: string) => headers.set(name, value),
        },
        session: {
            sessionInfo: {
                id: 's1',
                data: { oauthState: storedState, oauthProvider: storedProvider },
            },
            updateSessionData: vi.fn(() => Promise.resolve({ id: 's1', data: {} })),
            consumeSessionData: vi.fn(() => Promise.resolve('consumed')),
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

    const consumeMock = (context: unknown): ReturnType<typeof vi.fn> =>
        (context as { session: { consumeSessionData: ReturnType<typeof vi.fn> } }).session
            .consumeSessionData

    // feat-119 (F2): the state is consumed before anything is done on its behalf.
    it('consumes the state before the sign-in', async () => {
        handleCallback.mockResolvedValue(Result.ok({ redirectUrl: '/?oauth=success' }))
        const context = createContext({ code: 'c', state: 'state-1' })

        await OAuthController.callback(context)

        const consume = consumeMock(context)
        expect(consume).toHaveBeenCalledWith({ oauthState: 'state-1', oauthProvider: 'google' }, [
            'oauthState',
            'oauthCodeVerifier',
            'oauthProvider',
        ])
        expect(consume.mock.invocationCallOrder[0]).toBeLessThan(
            handleCallback.mock.invocationCallOrder[0] ?? 0,
        )
    })

    it('a session deleted after it was read (logout in another tab): no sign-in, error redirect', async () => {
        const context = createContext({ code: 'c', state: 'state-1' })
        consumeMock(context).mockResolvedValue('gone')

        const response = await OAuthController.callback(context)

        expect(handleCallback).not.toHaveBeenCalled()
        expect(context.responseData.status).toBe(302)
        expect(context.headers.get('Location')).toContain('/?error=oauth_failed')
        expect(response).toMatchObject({ code: 'unauthorized', reason: 'session_revoked' })
    })

    // feat-123: a made-up state from another site's navigation does not use up the real one.
    it('a state that does not match is refused before anything is consumed', async () => {
        const context = createContext({ code: 'c', state: 'forged' })

        const response = await OAuthController.callback(context)

        expect(consumeMock(context)).not.toHaveBeenCalled()
        expect(handleCallback).not.toHaveBeenCalled()
        expect(context.headers.get('Location')).toBe('/?error=oauth_failed')
        expect(response).toMatchObject({ code: 'bad_request', message: 'OAuth state mismatch' })
    })

    // Review of feat-119: a state another callback consumed, or a new OAuth start replaced, is not
    // this callback's to use.
    it('a state already consumed or replaced: no sign-in, error redirect', async () => {
        const context = createContext({ code: 'c', state: 'state-1' })
        consumeMock(context).mockResolvedValue('mismatch')

        const response = await OAuthController.callback(context)

        expect(handleCallback).not.toHaveBeenCalled()
        expect(context.responseData.status).toBe(302)
        expect(context.headers.get('Location')).toBe('/?error=oauth_failed')
        expect(response).toMatchObject({
            code: 'bad_request',
            message: 'OAuth state was already used or replaced',
        })
    })

    // feat-095: a failed session write must not turn the browser navigation into a JSON 5xx page.
    it('a state that cannot be consumed (Redis down): no sign-in, still a redirect', async () => {
        const context = createContext({ code: 'c', state: 'state-1' })
        consumeMock(context).mockRejectedValue(new Error('Command timed out'))

        await OAuthController.callback(context)

        expect(handleCallback).not.toHaveBeenCalled()
        expect(context.responseData.status).toBe(302)
        expect(context.headers.get('Location')).toBe('/?error=oauth_failed')
        expect(context.logger.error).toHaveBeenCalledWith(
            expect.objectContaining({ err: expect.any(Error) }),
            'OAuth state could not be consumed',
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

    // feat-097: the browser session is what a mailed link confirmation is bound to.
    it('passes the browser session id to the service', async () => {
        handleCallback.mockResolvedValue(Result.ok({ redirectUrl: '/?oauth=success' }))
        const context = createContext({ code: 'c', state: 'state-1' })

        await OAuthController.callback(context)

        expect(handleCallback).toHaveBeenCalledWith(
            'google',
            'c',
            'state-1',
            'state-1',
            null,
            context.auth,
            's1',
        )
    })

    it.each([
        ['BadRequest', 'oauth_link_revoked'],
        ['Conflict', 'email_changed'],
        ['Conflict', 'oauth_already_linked'],
    ])('adds the reason of a %s %s to the error redirect', async (tag, reason) => {
        handleCallback.mockResolvedValue(Result.err({ _tag: tag, message: 'x', reason }))
        const context = createContext({ code: 'c', state: 'state-1' })

        await OAuthController.callback(context)

        expect(context.responseData.status).toBe(302)
        expect(context.headers.get('Location')).toBe(`/?error=oauth_failed&reason=${reason}`)
    })

    it.each([['oauth_email_unverified'], ['used_token'], ['anything_else']])(
        'does not put an unlisted reason (%s) into the redirect',
        async (reason) => {
            handleCallback.mockResolvedValue(Result.err({ _tag: 'Conflict', message: 'x', reason }))
            const context = createContext({ code: 'c', state: 'state-1' })

            await OAuthController.callback(context)

            expect(context.headers.get('Location')).toBe('/?error=oauth_failed')
        },
    )
})

const createJsonContext = (options: {
    payload?: unknown
    sessionId?: string | null
    userId?: string | null
    presentedToken?: string
    stored?: boolean
}) => {
    const userId = options.userId ?? null
    return {
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        signal: new AbortController().signal,
        httpData: { params: {}, query: {}, payload: options.payload ?? null },
        responseData: { status: 200, setHeader: vi.fn() },
        session: {
            sessionInfo:
                options.sessionId === null ? null : { id: options.sessionId ?? 's1', data: {} },
            isStored: vi.fn(() => Promise.resolve(options.stored ?? true)),
        },
        auth: {
            check: () => userId !== null,
            getUserId: () => userId,
            getPresentedUserToken: () => options.presentedToken,
        },
    } as never as Parameters<typeof OAuthController.confirmLink>[0]
}

describe('OAuthController.confirmLink', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('passes the token, auth and session id and answers the service value', async () => {
        confirmLink.mockResolvedValue(Result.ok({ status: 'success' }))
        const context = createJsonContext({ payload: { token: 'tok' } })

        const response = await OAuthController.confirmLink(context)

        expect(confirmLink).toHaveBeenCalledWith('tok', context.auth, 's1')
        expect(response).toEqual({ status: 'success' })
    })

    it('passes null without a session', async () => {
        confirmLink.mockResolvedValue(Result.ok({ status: 'success' }))
        const context = createJsonContext({ payload: { token: 'tok' }, sessionId: null })

        await OAuthController.confirmLink(context)

        expect(confirmLink).toHaveBeenCalledWith('tok', context.auth, null)
    })

    it('maps a wrong-session refusal to 403 with its reason', async () => {
        confirmLink.mockResolvedValue(
            Result.err({
                _tag: 'Forbidden',
                message: 'Open this link in the browser where you started signing in',
                reason: 'oauth_link_wrong_session',
            }),
        )
        const context = createJsonContext({ payload: { token: 'tok' } })

        const response = await OAuthController.confirmLink(context)

        expect(context.responseData.status).toBe(403)
        expect(response).toMatchObject({ status: 'error', reason: 'oauth_link_wrong_session' })
    })
})

describe('OAuthController.resendEmailLink', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('answers 401 without a signed-in user and does not call the service', async () => {
        const context = createJsonContext({})

        await OAuthController.resendEmailLink(context)

        expect(context.responseData.status).toBe(401)
        expect(resendFirstEmailLink).not.toHaveBeenCalled()
    })

    it('passes the user id and the presented session token', async () => {
        resendFirstEmailLink.mockResolvedValue(Result.ok({ message: 'Verification email sent' }))
        const context = createJsonContext({ userId: '7', presentedToken: 'presented' })

        const response = await OAuthController.resendEmailLink(context)

        expect(resendFirstEmailLink).toHaveBeenCalledWith(7n, 'presented', expect.any(Function))
        expect(response).toEqual({ status: 'success', message: 'Verification email sent' })
    })

    // feat-129: the guard is the request's own session check, not a stand-in.
    it('hands over the request session check as the guard', async () => {
        resendFirstEmailLink.mockResolvedValue(Result.ok({ message: 'Verification email sent' }))
        const context = createJsonContext({ userId: '7', presentedToken: 'p', stored: false })

        await OAuthController.resendEmailLink(context)

        const guard = resendFirstEmailLink.mock.calls[0]![2] as () => Promise<boolean>
        await expect(guard()).resolves.toBe(false)
        expect(
            (context as unknown as { session: { isStored: ReturnType<typeof vi.fn> } }).session
                .isStored,
        ).toHaveBeenCalledOnce()
    })

    it('maps a service error', async () => {
        resendFirstEmailLink.mockResolvedValue(
            Result.err({ _tag: 'Conflict', message: 'Email is already linked to another account' }),
        )
        const context = createJsonContext({ userId: '7', presentedToken: 'presented' })

        await OAuthController.resendEmailLink(context)

        expect(context.responseData.status).toBe(409)
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

// feat-150 (review 2026-11-10): the authorization URL carries the single-use state and the PKCE
// challenge. The log names the provider only.
describe('OAuthController.redirect', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('redirects to the provider without logging the URL or the state', async () => {
        getAuthorizationUrl.mockReturnValue(
            Result.ok({
                url: 'https://accounts.example/authorize?state=state-secret-1&code_challenge=challenge-1',
                state: 'state-secret-1',
                codeVerifier: 'verifier-secret-1',
            }),
        )
        const context = createContext({})

        await OAuthController.redirect(context)

        expect(context.responseData.status).toBe(302)
        expect(context.headers.get('Location')).toContain('state=state-secret-1')
        const logged = JSON.stringify(
            (context.logger.info as unknown as ReturnType<typeof vi.fn>).mock.calls,
        )
        expect(logged).not.toContain('state-secret-1')
        expect(logged).not.toContain('challenge-1')
        expect(logged).not.toContain('verifier-secret-1')
        expect(logged).toContain('google')
    })

    // feat-200 (L-7): the state is stored with the provider it was issued for.
    it('stores the provider with the state and the verifier', async () => {
        getAuthorizationUrl.mockReturnValue(
            Result.ok({ url: 'https://accounts.example/a', state: 's-1', codeVerifier: 'v-1' }),
        )
        const context = createContext({})

        await OAuthController.redirect(context)

        expect(
            (context as unknown as { session: { updateSessionData: ReturnType<typeof vi.fn> } })
                .session.updateSessionData,
        ).toHaveBeenCalledWith({
            oauthState: 's-1',
            oauthCodeVerifier: 'v-1',
            oauthProvider: 'google',
        })
    })

    // feat-200 (L-6): another site must not start a sign-in in this browser.
    it('refuses a navigation from another site: 403, no state issued, nothing stored', async () => {
        const context = createContext({}, 'state-1', 'google', { 'sec-fetch-site': 'cross-site' })

        const answer = await OAuthController.redirect(context)

        expect(context.responseData.status).toBe(403)
        expect(answer).toMatchObject({ status: 'error', reason: 'oauth_cross_site_start' })
        expect(context.headers.get('Location')).toBeUndefined()
        expect(getAuthorizationUrl).not.toHaveBeenCalled()
        expect(
            (context as unknown as { session: { updateSessionData: ReturnType<typeof vi.fn> } })
                .session.updateSessionData,
        ).not.toHaveBeenCalled()
    })

    it.each([
        ['the application itself', { 'sec-fetch-site': 'same-origin' }],
        ['another port or subdomain of the site', { 'sec-fetch-site': 'same-site' }],
        ['a typed address or a bookmark', { 'sec-fetch-site': 'none' }],
        ['a browser or client that sends no Fetch Metadata', {}],
    ])('lets a start from %s through', async (_label, requestHeaders) => {
        getAuthorizationUrl.mockReturnValue(
            Result.ok({ url: 'https://accounts.example/a', state: 's-1', codeVerifier: null }),
        )
        const context = createContext({}, 'state-1', 'google', requestHeaders)

        await OAuthController.redirect(context)

        expect(context.responseData.status).toBe(302)
        expect(context.headers.get('Location')).toBe('https://accounts.example/a')
    })
})

// feat-200 (L-7): a state issued for one provider used to be accepted on the callback of another.
describe('OAuthController.callback: the state belongs to its provider', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it.each([
        ['issued for another provider', 'github'],
        ['stored without a provider', ''],
    ])('refuses a state %s before anything is consumed', async (_label, storedProvider) => {
        const context = createContext({ code: 'c', state: 'state-1' }, 'state-1', storedProvider)

        await OAuthController.callback(context)

        expect(context.responseData.status).toBe(302)
        expect(context.headers.get('Location')).toBe('/?error=oauth_failed')
        expect(
            (context as unknown as { session: { consumeSessionData: ReturnType<typeof vi.fn> } })
                .session.consumeSessionData,
        ).not.toHaveBeenCalled()
        expect(handleCallback).not.toHaveBeenCalled()
    })
})
