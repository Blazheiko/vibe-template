import { Result } from 'better-result'
import { afterEach, describe, expect, it, vi } from 'vitest'

const userRepositoryMock = {
    findById: vi.fn(),
    findByEmail: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
}

const oauthAccountRepositoryMock = {
    findByProviderAndProviderId: vi.fn(),
    create: vi.fn(),
}

const authMock = {
    login: vi.fn(),
}

const loggerMock = {
    info: vi.fn(),
    warn: vi.fn(),
}

const googleValidateAuthorizationCodeMock = vi.fn()
const googleCreateAuthorizationUrlMock = vi.fn(
    () => new URL('https://accounts.google.com/o/oauth2/v2/auth'),
)
const facebookValidateAuthorizationCodeMock = vi.fn()
const facebookCreateAuthorizationUrlMock = vi.fn(
    () => new URL('https://www.facebook.com/v19.0/dialog/oauth'),
)
const githubValidateAuthorizationCodeMock = vi.fn()
const githubCreateAuthorizationUrlMock = vi.fn(
    () => new URL('https://github.com/login/oauth/authorize'),
)
const gitlabValidateAuthorizationCodeMock = vi.fn()
const gitlabCreateAuthorizationUrlMock = vi.fn(() => new URL('https://gitlab.com/oauth/authorize'))

vi.mock('#config/oauth.js', () => ({
    default: {
        google: {
            clientId: 'google-client',
            clientSecret: 'google-secret',
            redirectUri: 'https://app.example.com/oauth/google/callback',
        },
        facebook: {
            clientId: 'facebook-client',
            clientSecret: 'facebook-secret',
            redirectUri: 'https://app.example.com/oauth/facebook/callback',
        },
        github: {
            clientId: 'github-client',
            clientSecret: 'github-secret',
            redirectUri: 'https://app.example.com/oauth/github/callback',
        },
        gitlab: {
            clientId: 'gitlab-client',
            clientSecret: 'gitlab-secret',
            redirectUri: 'https://app.example.com/oauth/gitlab/callback',
        },
        frontendSuccessUrl: 'https://app.example.com/oauth/success',
        frontendErrorUrl: 'https://app.example.com/oauth/error',
    },
}))

vi.mock('#app/repositories/index.js', () => ({
    userRepository: userRepositoryMock,
    oauthAccountRepository: oauthAccountRepositoryMock,
}))

vi.mock('#vendor/utils/logger.js', () => ({
    default: loggerMock,
}))

vi.mock('arctic', () => ({
    Google: class {
        createAuthorizationURL = googleCreateAuthorizationUrlMock
        validateAuthorizationCode = googleValidateAuthorizationCodeMock
    },
    Facebook: class {
        createAuthorizationURL = facebookCreateAuthorizationUrlMock
        validateAuthorizationCode = facebookValidateAuthorizationCodeMock
    },
    GitHub: class {
        createAuthorizationURL = githubCreateAuthorizationUrlMock
        validateAuthorizationCode = githubValidateAuthorizationCodeMock
    },
    GitLab: class {
        createAuthorizationURL = gitlabCreateAuthorizationUrlMock
        validateAuthorizationCode = gitlabValidateAuthorizationCodeMock
    },
    generateState: vi.fn(() => 'oauth-state'),
    generateCodeVerifier: vi.fn(() => 'code-verifier'),
}))

async function loadOauthService() {
    return import('./oauth-service.js')
}

// Answers each provider API URL with its own JSON body.
function stubFetch(responses: Record<string, unknown>): void {
    vi.stubGlobal(
        'fetch',
        vi.fn((url: string) => {
            const key = Object.keys(responses).find((prefix) => url.startsWith(prefix))
            if (key === undefined) throw new Error(`unexpected fetch ${url}`)
            return Promise.resolve({ json: vi.fn().mockResolvedValue(responses[key]) })
        }),
    )
}

const GITHUB_USER = {
    id: 'provider-user-1',
    email: 'user@example.com',
    name: 'Jane',
    avatar_url: 'https://cdn.example.com/avatar.png',
}

function stubGitHubUserInfoFetch(
    emails: unknown[] = [{ email: 'user@example.com', primary: true, verified: true }],
): void {
    stubFetch({
        'https://api.github.com/user/emails': emails,
        'https://api.github.com/user': GITHUB_USER,
    })
}

// JSON with bigint ids, for searching a mock's calls for a string.
const serialize = (value: unknown): string =>
    JSON.stringify(value, (_key, item: unknown) => (typeof item === 'bigint' ? String(item) : item))

const tokens = (accessToken: string) => ({
    accessToken: () => accessToken,
    hasRefreshToken: () => false,
    refreshToken: () => null,
})

async function callback(provider: string) {
    const { oauthService } = await loadOauthService()
    return oauthService.handleCallback(
        provider,
        'oauth-code',
        'oauth-state',
        'oauth-state',
        provider === 'google' ? 'code-verifier' : null,
        authMock as any,
    )
}

// No OAuth link yet, but a user with the same email already exists.
function givenExistingUserByEmail(): void {
    oauthAccountRepositoryMock.findByProviderAndProviderId.mockResolvedValue(undefined)
    userRepositoryMock.findByEmail.mockResolvedValue({ id: 5n, sessionToken: 'existing-token' })
    oauthAccountRepositoryMock.create.mockResolvedValue({ id: 30n, userId: 5n })
    authMock.login.mockResolvedValue(true)
}

function expectLinkRefused(result: Awaited<ReturnType<typeof callback>>): void {
    expect(Result.isError(result)).toBe(true)
    if (Result.isError(result)) {
        expect(result.error).toMatchObject({ _tag: 'Conflict', reason: 'oauth_email_unverified' })
    }
    expect(oauthAccountRepositoryMock.create).not.toHaveBeenCalled()
    expect(userRepositoryMock.create).not.toHaveBeenCalled()
    expect(authMock.login).not.toHaveBeenCalled()
}

// Blanks one credential of a provider for the current test; restored in afterEach.
const restoreConfig: (() => void)[] = []
async function unsetCredential(
    provider: 'google' | 'facebook' | 'github' | 'gitlab',
    field: 'clientId' | 'clientSecret' | 'redirectUri',
): Promise<void> {
    const { default: config } = await import('#config/oauth.js')
    const credentials = config[provider] as Record<typeof field, string>
    const original = credentials[field]
    credentials[field] = ''
    restoreConfig.push(() => {
        credentials[field] = original
    })
}

afterEach(() => {
    restoreConfig.splice(0).forEach((restore) => {
        restore()
    })
    vi.resetModules()
    vi.clearAllMocks()
    vi.unstubAllGlobals()
})

describe('oauthService', () => {
    it('logs in a returning user linked to an existing OAuth account', async () => {
        githubValidateAuthorizationCodeMock.mockResolvedValue({
            accessToken: () => 'github-access-token',
            hasRefreshToken: () => false,
            refreshToken: () => null,
        })
        stubGitHubUserInfoFetch()
        oauthAccountRepositoryMock.findByProviderAndProviderId.mockResolvedValue({
            id: 21n,
            userId: 7n,
        })
        userRepositoryMock.findById.mockResolvedValue({
            id: 7n,
            sessionToken: 'session-token',
        })
        authMock.login.mockResolvedValue(true)

        const { oauthService } = await loadOauthService()
        const result = await oauthService.handleCallback(
            'github',
            'oauth-code',
            'oauth-state',
            'oauth-state',
            null,
            authMock as any,
        )

        expect(Result.isOk(result)).toBe(true)
        if (Result.isOk(result)) {
            expect(result.value).toEqual({
                redirectUrl: 'https://app.example.com/oauth/success',
            })
        }
        expect(oauthAccountRepositoryMock.findByProviderAndProviderId).toHaveBeenCalledWith(
            'github',
            'provider-user-1',
        )
        // The provider tokens are used once, to read the profile, and are not kept.
        expect(oauthAccountRepositoryMock).not.toHaveProperty('updateTokens')
        expect(oauthAccountRepositoryMock.create).not.toHaveBeenCalled()
        expect(authMock.login).toHaveBeenCalledWith('7', 'session-token')
        expect(userRepositoryMock.create).not.toHaveBeenCalled()
    })

    it('creates a new user and OAuth link for first-time OAuth login', async () => {
        githubValidateAuthorizationCodeMock.mockResolvedValue({
            accessToken: () => 'github-access-token',
            hasRefreshToken: () => false,
            refreshToken: () => null,
        })
        stubGitHubUserInfoFetch()
        oauthAccountRepositoryMock.findByProviderAndProviderId.mockResolvedValue(undefined)
        userRepositoryMock.findByEmail.mockResolvedValue(undefined)
        userRepositoryMock.create.mockResolvedValue({
            id: 8n,
            sessionToken: 'new-session-token',
        })
        oauthAccountRepositoryMock.create.mockResolvedValue({
            id: 22n,
            userId: 8n,
        })
        authMock.login.mockResolvedValue(true)

        const { oauthService } = await loadOauthService()
        const result = await oauthService.handleCallback(
            'github',
            'oauth-code',
            'oauth-state',
            'oauth-state',
            null,
            authMock as any,
        )

        expect(Result.isOk(result)).toBe(true)
        if (Result.isOk(result)) {
            expect(result.value).toEqual({
                redirectUrl: 'https://app.example.com/oauth/success',
            })
        }
        expect(userRepositoryMock.create).toHaveBeenCalledWith({
            name: 'Jane',
            email: 'user@example.com',
            password: null,
            avatar: 'https://cdn.example.com/avatar.png',
            emailVerifiedAt: expect.any(Date),
        })
        expect(oauthAccountRepositoryMock.create).toHaveBeenCalledWith({
            userId: 8n,
            provider: 'github',
            providerUserId: 'provider-user-1',
            providerEmail: 'user@example.com',
            providerName: 'Jane',
            providerAvatar: 'https://cdn.example.com/avatar.png',
        })
        expect(authMock.login).toHaveBeenCalledWith('8', 'new-session-token')
    })

    describe('linking to an existing user by email', () => {
        it('links when Google reports the email as verified', async () => {
            googleValidateAuthorizationCodeMock.mockResolvedValue(tokens('google-token'))
            stubFetch({
                'https://www.googleapis.com/oauth2/v2/userinfo': {
                    id: 'g-1',
                    email: 'User@Example.com',
                    name: 'Jane',
                    verified_email: true,
                },
            })
            givenExistingUserByEmail()

            const result = await callback('google')

            expect(Result.isOk(result)).toBe(true)
            expect(userRepositoryMock.findByEmail).toHaveBeenCalledWith('user@example.com')
            expect(oauthAccountRepositoryMock.create).toHaveBeenCalledWith(
                expect.objectContaining({ userId: 5n, provider: 'google', providerUserId: 'g-1' }),
            )
            expect(authMock.login).toHaveBeenCalledWith('5', 'existing-token')
        })

        it('refuses when Google reports the email as unverified', async () => {
            googleValidateAuthorizationCodeMock.mockResolvedValue(tokens('google-token'))
            stubFetch({
                'https://www.googleapis.com/oauth2/v2/userinfo': {
                    id: 'g-1',
                    email: 'user@example.com',
                    name: 'Jane',
                    verified_email: false,
                },
            })
            givenExistingUserByEmail()

            expectLinkRefused(await callback('google'))
        })

        it('never links a Facebook login by email', async () => {
            facebookValidateAuthorizationCodeMock.mockResolvedValue(tokens('fb-token'))
            stubFetch({
                'https://graph.facebook.com/me': {
                    id: 'fb-1',
                    email: 'user@example.com',
                    name: 'Jane',
                    verified: true,
                },
            })
            givenExistingUserByEmail()

            expectLinkRefused(await callback('facebook'))
        })

        it('links GitLab only when OIDC userinfo verifies the same email', async () => {
            gitlabValidateAuthorizationCodeMock.mockResolvedValue(tokens('gl-token'))
            stubFetch({
                'https://gitlab.com/api/v4/user': {
                    id: 9,
                    email: 'user@example.com',
                    name: 'Jane',
                },
                'https://gitlab.com/oauth/userinfo': {
                    email: 'user@example.com',
                    email_verified: true,
                },
            })
            givenExistingUserByEmail()

            const result = await callback('gitlab')

            expect(Result.isOk(result)).toBe(true)
            expect(authMock.login).toHaveBeenCalledWith('5', 'existing-token')
        })

        it.each([
            ['unverified', { email: 'user@example.com', email_verified: false }],
            ['verified for another address', { email: 'other@example.com', email_verified: true }],
            ['missing (no openid scope)', {}],
        ])('refuses GitLab when the userinfo email is %s', async (_label, userinfo) => {
            gitlabValidateAuthorizationCodeMock.mockResolvedValue(tokens('gl-token'))
            stubFetch({
                'https://gitlab.com/api/v4/user': {
                    id: 9,
                    email: 'user@example.com',
                    name: 'Jane',
                },
                'https://gitlab.com/oauth/userinfo': userinfo,
            })
            givenExistingUserByEmail()

            expectLinkRefused(await callback('gitlab'))
        })

        it('creates an unverified user when the provider does not verify the email', async () => {
            facebookValidateAuthorizationCodeMock.mockResolvedValue(tokens('fb-token'))
            stubFetch({
                'https://graph.facebook.com/me': {
                    id: 'fb-1',
                    email: 'new@example.com',
                    name: 'Jane',
                },
            })
            oauthAccountRepositoryMock.findByProviderAndProviderId.mockResolvedValue(undefined)
            userRepositoryMock.findByEmail.mockResolvedValue(undefined)
            userRepositoryMock.create.mockResolvedValue({ id: 8n, sessionToken: 'new-token' })
            oauthAccountRepositoryMock.create.mockResolvedValue({ id: 22n, userId: 8n })
            authMock.login.mockResolvedValue(true)

            const result = await callback('facebook')

            expect(Result.isOk(result)).toBe(true)
            expect(userRepositoryMock.create).toHaveBeenCalledWith(
                expect.not.objectContaining({ emailVerifiedAt: expect.anything() }),
            )
        })
    })

    it('ignores an unverified GitHub email and fails without a verified primary one', async () => {
        githubValidateAuthorizationCodeMock.mockResolvedValue(tokens('github-access-token'))
        stubGitHubUserInfoFetch([
            { email: 'user@example.com', primary: true, verified: false },
            { email: 'second@example.com', primary: false, verified: true },
        ])
        oauthAccountRepositoryMock.findByProviderAndProviderId.mockResolvedValue(undefined)

        const result = await callback('github')

        expect(Result.isError(result)).toBe(true)
        if (Result.isError(result)) {
            expect(result.error).toMatchObject({
                _tag: 'BadRequest',
                message: 'Could not retrieve email from provider',
            })
        }
        expect(authMock.login).not.toHaveBeenCalled()
    })

    // feat-064: nothing reads a provider's access or refresh token after the profile has been
    // fetched, so they are not stored (a plaintext token at rest is a liability, not a feature).
    describe('provider tokens are not stored', () => {
        const withRefresh = (accessToken: string) => ({
            accessToken: () => accessToken,
            hasRefreshToken: () => true,
            refreshToken: () => 'secret-refresh-token',
        })

        it.each([
            ['google', withRefresh('secret-access-token')],
            ['gitlab', withRefresh('secret-access-token')],
        ])(
            '%s: neither token reaches the repository when a link is created',
            async (provider, grant) => {
                ;(provider === 'google'
                    ? googleValidateAuthorizationCodeMock
                    : gitlabValidateAuthorizationCodeMock
                ).mockResolvedValue(grant)
                stubFetch({
                    'https://www.googleapis.com/oauth2/v2/userinfo': {
                        id: 'p-1',
                        email: 'user@example.com',
                        name: 'Jane',
                        verified_email: true,
                    },
                    'https://gitlab.com/oauth/userinfo': {
                        sub: 'p-1',
                        email: 'user@example.com',
                        email_verified: true,
                        name: 'Jane',
                    },
                    'https://gitlab.com/api/v4/user': {
                        id: 'p-1',
                        email: 'user@example.com',
                        name: 'Jane',
                    },
                })
                oauthAccountRepositoryMock.findByProviderAndProviderId.mockResolvedValue(undefined)
                userRepositoryMock.findByEmail.mockResolvedValue(undefined)
                userRepositoryMock.create.mockResolvedValue({ id: 8n, sessionToken: 'tok' })
                oauthAccountRepositoryMock.create.mockResolvedValue({ id: 22n, userId: 8n })
                authMock.login.mockResolvedValue(true)

                await callback(provider)

                const stored = serialize(oauthAccountRepositoryMock.create.mock.calls)
                expect(oauthAccountRepositoryMock.create).toHaveBeenCalledTimes(1)
                expect(stored).not.toContain('secret-access-token')
                expect(stored).not.toContain('secret-refresh-token')
                expect(oauthAccountRepositoryMock.create.mock.calls[0]?.[0]).not.toHaveProperty(
                    'accessToken',
                )
                expect(oauthAccountRepositoryMock.create.mock.calls[0]?.[0]).not.toHaveProperty(
                    'refreshToken',
                )
            },
        )

        it('a returning user is logged in without any write to the OAuth account', async () => {
            googleValidateAuthorizationCodeMock.mockResolvedValue(
                withRefresh('secret-access-token'),
            )
            stubFetch({
                'https://www.googleapis.com/oauth2/v2/userinfo': {
                    id: 'g-1',
                    email: 'user@example.com',
                    name: 'Jane',
                    verified_email: true,
                },
            })
            oauthAccountRepositoryMock.findByProviderAndProviderId.mockResolvedValue({
                id: 21n,
                userId: 7n,
            })
            userRepositoryMock.findById.mockResolvedValue({ id: 7n, sessionToken: 'session-token' })
            authMock.login.mockResolvedValue(true)

            const result = await callback('google')

            expect(Result.isOk(result)).toBe(true)
            expect(oauthAccountRepositoryMock.create).not.toHaveBeenCalled()
            expect(authMock.login).toHaveBeenCalledWith('7', 'session-token')
        })
    })

    // The Facebook token used to travel in the query string (`?access_token=`), where it lands
    // in proxy and CDN logs and in Referer headers; the Graph API accepts it as a Bearer header.
    describe('the Facebook access token', () => {
        it('goes in the Authorization header, never in the URL', async () => {
            facebookValidateAuthorizationCodeMock.mockResolvedValue(tokens('fb-secret-token'))
            const calls: { url: string; init: RequestInit | undefined }[] = []
            vi.stubGlobal(
                'fetch',
                vi.fn((url: string, init?: RequestInit) => {
                    calls.push({ url, init })
                    return Promise.resolve({
                        json: vi.fn().mockResolvedValue({
                            id: 'fb-1',
                            email: 'user@example.com',
                            name: 'Jane',
                        }),
                    })
                }),
            )
            oauthAccountRepositoryMock.findByProviderAndProviderId.mockResolvedValue({
                id: 21n,
                userId: 7n,
            })
            userRepositoryMock.findById.mockResolvedValue({ id: 7n, sessionToken: 'session-token' })
            authMock.login.mockResolvedValue(true)

            await callback('facebook')

            expect(calls).toHaveLength(1)
            expect(calls[0]?.url).toMatch(/^https:\/\/graph\.facebook\.com\/me\?fields=/)
            expect(calls[0]?.url).not.toContain('access_token')
            expect(calls[0]?.url).not.toContain('fb-secret-token')
            expect(calls[0]?.init?.headers).toEqual({ Authorization: 'Bearer fb-secret-token' })
        })
    })

    // feat-064: an email address and a name are personal data; the log keeps the provider and
    // a masked address, enough to correlate a report without exposing the person.
    describe('what the log says about the person', () => {
        const everythingLogged = (): string =>
            serialize([...loggerMock.info.mock.calls, ...loggerMock.warn.mock.calls])

        it.each([
            ['a returning user', true],
            ['a new user', false],
        ])('does not log the raw email or the name of %s', async (_label, returning) => {
            githubValidateAuthorizationCodeMock.mockResolvedValue(tokens('gh-secret-token'))
            stubGitHubUserInfoFetch()
            oauthAccountRepositoryMock.findByProviderAndProviderId.mockResolvedValue(
                returning ? { id: 21n, userId: 7n } : undefined,
            )
            userRepositoryMock.findById.mockResolvedValue({ id: 7n, sessionToken: 'session-token' })
            userRepositoryMock.findByEmail.mockResolvedValue(undefined)
            userRepositoryMock.create.mockResolvedValue({ id: 8n, sessionToken: 'tok' })
            oauthAccountRepositoryMock.create.mockResolvedValue({ id: 22n, userId: 8n })
            authMock.login.mockResolvedValue(true)

            await callback('github')

            const logged = everythingLogged()
            expect(logged).not.toContain('user@example.com')
            expect(logged).not.toContain('Jane')
            expect(logged).not.toContain('gh-secret-token')
            // Still useful: the address is there, masked.
            expect(logged).toContain('u***r@e*****e.com')
        })

        it('does not log the raw email when a link is refused', async () => {
            googleValidateAuthorizationCodeMock.mockResolvedValue(tokens('google-token'))
            stubFetch({
                'https://www.googleapis.com/oauth2/v2/userinfo': {
                    id: 'g-1',
                    email: 'user@example.com',
                    name: 'Jane',
                    verified_email: false,
                },
            })
            givenExistingUserByEmail()

            await callback('google')

            expect(everythingLogged()).not.toContain('user@example.com')
            expect(everythingLogged()).not.toContain('Jane')
        })
    })

    describe('configured providers', () => {
        it('lists only providers with client id, secret and redirect URI', async () => {
            await unsetCredential('facebook', 'clientSecret')
            await unsetCredential('gitlab', 'redirectUri')

            const { oauthService } = await loadOauthService()

            expect(oauthService.getConfiguredProviders()).toEqual(['google', 'github'])
        })

        it('does not build a redirect URL for an unconfigured provider', async () => {
            await unsetCredential('github', 'clientId')

            const { oauthService } = await loadOauthService()
            const result = oauthService.getAuthorizationUrl('github')

            expect(Result.isError(result)).toBe(true)
            if (Result.isError(result)) {
                expect(result.error).toMatchObject({ _tag: 'NotFound' })
            }
            expect(githubCreateAuthorizationUrlMock).not.toHaveBeenCalled()
        })

        it('requests the OIDC scopes from GitLab', async () => {
            const { oauthService } = await loadOauthService()
            oauthService.getAuthorizationUrl('gitlab')

            expect(gitlabCreateAuthorizationUrlMock).toHaveBeenCalledWith('oauth-state', [
                'openid',
                'email',
                'read_user',
            ])
        })
    })
})
