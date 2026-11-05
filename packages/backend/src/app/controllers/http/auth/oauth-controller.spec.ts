import { Result } from 'better-result'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The OAuth callback is a browser navigation: every outcome must be a 302 back to the
// frontend, never an error status that leaves the user on a raw JSON page.

const { handleCallback, getConfiguredProviders, confirmLink, resendFirstEmailLink } = vi.hoisted(
    () => ({
        handleCallback: vi.fn(),
        getConfiguredProviders: vi.fn(),
        confirmLink: vi.fn(),
        resendFirstEmailLink: vi.fn(),
    }),
)

vi.mock('#app/services/auth/oauth-service.js', () => ({
    OAUTH_LINK_REVOKED: 'oauth_link_revoked',
    EMAIL_CHANGED: 'email_changed',
    OAUTH_ALREADY_LINKED: 'oauth_already_linked',
    TOO_MANY_ATTEMPTS: 'too_many_attempts',
    oauthService: { handleCallback, getConfiguredProviders, confirmLink, resendFirstEmailLink },
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
        expect(consume).toHaveBeenCalledWith({ oauthState: 'state-1' }, [
            'oauthState',
            'oauthCodeVerifier',
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
