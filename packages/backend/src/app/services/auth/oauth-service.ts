import { Google, Facebook, GitHub, GitLab, generateState, generateCodeVerifier } from 'arctic'
import oauthConfig from '#config/oauth.js'
import { userRepository, oauthAccountRepository } from '#app/repositories/index.js'
import { Result } from 'better-result'
import { badRequest, conflict, notFound, type AppResult } from '#app/services/shared/errors.js'
import { tryInternal } from '#app/services/shared/result-helpers.js'
import type { Auth } from '#vendor/types/types.js'
import logger from '#vendor/utils/logger.js'
import { normalizeEmail } from '#app/services/auth/auth-normalize.js'
import { maskEmailForLogs } from '#vendor/utils/helpers/mask-sensitive.js'
import { userNotificationService } from '#app/services/notifications/user-notification-service.js'

async function fetchJson(
    url: string,
    headers?: Record<string, string>,
): Promise<Record<string, unknown>> {
    const response = await fetch(url, headers !== undefined ? { headers } : undefined)

    const data = await (response as unknown as { json(): Promise<unknown> }).json()
    return data as Record<string, unknown>
}

async function fetchJsonArray(
    url: string,
    headers?: Record<string, string>,
): Promise<Record<string, unknown>[]> {
    const response = await fetch(url, headers !== undefined ? { headers } : undefined)

    const data = await (response as unknown as { json(): Promise<unknown> }).json()
    return data as Record<string, unknown>[]
}

const SUPPORTED_PROVIDERS = ['google', 'facebook', 'github', 'gitlab'] as const
type OAuthProvider = (typeof SUPPORTED_PROVIDERS)[number]

function isValidProvider(provider: string): provider is OAuthProvider {
    return (SUPPORTED_PROVIDERS as readonly string[]).includes(provider)
}

// A provider is usable only when all three credentials are set; without them the
// redirect would send the user to the provider with an empty client_id.
function isProviderConfigured(provider: OAuthProvider): boolean {
    const { clientId, clientSecret, redirectUri } = oauthConfig[provider]
    return clientId !== '' && clientSecret !== '' && redirectUri !== ''
}

function getConfiguredProviders(): OAuthProvider[] {
    return SUPPORTED_PROVIDERS.filter(isProviderConfigured)
}

// Shown to the user (via the frontend) when an existing account would be linked
// through an email the provider does not vouch for.
export const OAUTH_EMAIL_UNVERIFIED = 'oauth_email_unverified'

function createGoogleClient(): Google {
    return new Google(
        oauthConfig.google.clientId,
        oauthConfig.google.clientSecret,
        oauthConfig.google.redirectUri,
    )
}

function createFacebookClient(): Facebook {
    return new Facebook(
        oauthConfig.facebook.clientId,
        oauthConfig.facebook.clientSecret,
        oauthConfig.facebook.redirectUri,
    )
}

function createGitHubClient(): GitHub {
    return new GitHub(
        oauthConfig.github.clientId,
        oauthConfig.github.clientSecret,
        oauthConfig.github.redirectUri,
    )
}

function createGitLabClient(): GitLab {
    return new GitLab(
        'https://gitlab.com',
        oauthConfig.gitlab.clientId,
        oauthConfig.gitlab.clientSecret,
        oauthConfig.gitlab.redirectUri,
    )
}

interface OAuthUserInfo {
    id: string
    email: string
    name: string
    avatar: string | null
    // Whether the provider confirms the user owns `email`. Linking to an existing
    // account by email is allowed only when this is true.
    emailVerified: boolean
}

async function fetchGoogleUserInfo(accessToken: string): Promise<OAuthUserInfo> {
    const data = await fetchJson('https://www.googleapis.com/oauth2/v2/userinfo', {
        Authorization: `Bearer ${accessToken}`,
    })
    return {
        id:
            typeof data['id'] === 'string' || typeof data['id'] === 'number'
                ? String(data['id'])
                : '',
        email: typeof data['email'] === 'string' ? data['email'] : '',
        name: typeof data['name'] === 'string' ? data['name'] : '',
        avatar: typeof data['picture'] === 'string' ? data['picture'] : null,
        emailVerified: data['verified_email'] === true,
    }
}

async function fetchFacebookUserInfo(accessToken: string): Promise<OAuthUserInfo> {
    // The token goes in the header: in the query string it lands in proxy and CDN logs and
    // in Referer headers.
    const data = await fetchJson(
        'https://graph.facebook.com/me?fields=id,name,email,picture.type(large)',
        { Authorization: `Bearer ${accessToken}` },
    )
    const picture = data['picture'] as Record<string, unknown> | undefined
    const pictureData = picture?.['data'] as Record<string, unknown> | undefined
    return {
        id:
            typeof data['id'] === 'string' || typeof data['id'] === 'number'
                ? String(data['id'])
                : '',
        email: typeof data['email'] === 'string' ? data['email'] : '',
        name: typeof data['name'] === 'string' ? data['name'] : '',
        avatar: typeof pictureData?.['url'] === 'string' ? pictureData['url'] : null,
        // The Graph API has no "email confirmed" flag (`verified` is about the account).
        emailVerified: false,
    }
}

async function fetchGitHubUserInfo(accessToken: string): Promise<OAuthUserInfo> {
    const headers = { Authorization: `Bearer ${accessToken}` }
    const data = await fetchJson('https://api.github.com/user', headers)

    // The public `email` of /user is not guaranteed to be verified, so the address
    // always comes from /user/emails: the primary one, and only when verified.
    const emails = await fetchJsonArray('https://api.github.com/user/emails', headers)
    const primary = emails.find((e) => e['primary'] === true && e['verified'] === true)
    const email = typeof primary?.['email'] === 'string' ? primary['email'] : ''

    return {
        id:
            typeof data['id'] === 'string' || typeof data['id'] === 'number'
                ? String(data['id'])
                : '',
        email,
        name:
            typeof data['name'] === 'string'
                ? data['name']
                : typeof data['login'] === 'string'
                  ? data['login']
                  : '',
        avatar: typeof data['avatar_url'] === 'string' ? data['avatar_url'] : null,
        emailVerified: email !== '',
    }
}

async function fetchGitLabUserInfo(accessToken: string): Promise<OAuthUserInfo> {
    const headers = { Authorization: `Bearer ${accessToken}` }
    const data = await fetchJson('https://gitlab.com/api/v4/user', headers)
    // /api/v4/user has no verification flag; the OIDC userinfo endpoint does
    // (needs the `openid email` scopes).
    const userinfo = await fetchJson('https://gitlab.com/oauth/userinfo', headers)
    const email = typeof data['email'] === 'string' ? data['email'] : ''
    return {
        id:
            typeof data['id'] === 'string' || typeof data['id'] === 'number'
                ? String(data['id'])
                : '',
        email,
        name: typeof data['name'] === 'string' ? data['name'] : '',
        avatar: typeof data['avatar_url'] === 'string' ? data['avatar_url'] : null,
        emailVerified:
            email !== '' && userinfo['email_verified'] === true && userinfo['email'] === email,
    }
}

export const oauthService = {
    isValidProvider,
    isProviderConfigured,
    getConfiguredProviders,

    getAuthorizationUrl(provider: string): AppResult<{
        url: string
        state: string
        codeVerifier: string | null
    }> {
        if (!isValidProvider(provider)) {
            return Result.err(badRequest(`Unsupported provider: ${provider}`))
        }
        if (!isProviderConfigured(provider)) {
            return Result.err(notFound('OAuthProvider', `Provider not configured: ${provider}`))
        }

        const state = generateState()

        if (provider === 'google') {
            const codeVerifier = generateCodeVerifier()
            const url = createGoogleClient().createAuthorizationURL(state, codeVerifier, [
                'openid',
                'profile',
                'email',
            ])
            return Result.ok({ url: url.toString(), state, codeVerifier })
        }

        if (provider === 'facebook') {
            const url = createFacebookClient().createAuthorizationURL(state, [
                'email',
                'public_profile',
            ])
            return Result.ok({ url: url.toString(), state, codeVerifier: null })
        }

        if (provider === 'github') {
            const url = createGitHubClient().createAuthorizationURL(state, ['user:email'])
            return Result.ok({ url: url.toString(), state, codeVerifier: null })
        }

        // gitlab
        const url = createGitLabClient().createAuthorizationURL(state, [
            'openid',
            'email',
            'read_user',
        ])
        return Result.ok({ url: url.toString(), state, codeVerifier: null })
    },

    async handleCallback(
        provider: string,
        code: string,
        storedState: string,
        receivedState: string,
        codeVerifier: string | null,
        auth: Auth,
    ): Promise<AppResult<{ redirectUrl: string }>> {
        if (!isValidProvider(provider)) {
            return Result.err(badRequest(`Unsupported provider: ${provider}`))
        }
        if (!isProviderConfigured(provider)) {
            return Result.err(notFound('OAuthProvider', `Provider not configured: ${provider}`))
        }

        if (storedState !== receivedState) {
            return Result.err(badRequest('OAuth state mismatch'))
        }

        // The provider's tokens are used once, to read the profile, and are not kept: nothing
        // reads them afterwards, and a token at rest is a liability.
        let userInfo: OAuthUserInfo

        try {
            if (provider === 'google') {
                logger.info('provider google')
                const tokens = await createGoogleClient().validateAuthorizationCode(
                    code,
                    codeVerifier ?? '',
                )
                userInfo = await fetchGoogleUserInfo(tokens.accessToken())
            } else if (provider === 'facebook') {
                logger.info('provider facebook')
                const tokens = await createFacebookClient().validateAuthorizationCode(code)
                userInfo = await fetchFacebookUserInfo(tokens.accessToken())
            } else if (provider === 'github') {
                logger.info('provider github')
                const tokens = await createGitHubClient().validateAuthorizationCode(code)
                userInfo = await fetchGitHubUserInfo(tokens.accessToken())
            } else {
                logger.info('provider gitlab')
                const tokens = await createGitLabClient().validateAuthorizationCode(code)
                userInfo = await fetchGitLabUserInfo(tokens.accessToken())
            }
        } catch (err) {
            logger.warn({ err, provider }, 'OAuth code exchange failed')
            return Result.err(badRequest('Failed to exchange authorization code'))
        }

        // An address and a name are personal data: the log keeps the provider and a masked
        // address, enough to correlate a report.
        logger.info(
            { provider, email: maskEmailForLogs(userInfo.email) },
            'oauth provider user info received',
        )

        if (userInfo.email === '') {
            logger.warn({ provider }, 'oauth provider returned empty email')
            return Result.err(badRequest('Could not retrieve email from provider'))
        }

        userInfo.email = normalizeEmail(userInfo.email)

        // Find existing OAuth account link
        const existingOAuthResult = await tryInternal(
            () => oauthAccountRepository.findByProviderAndProviderId(provider, userInfo.id),
            'Failed to load OAuth account',
        )
        if (Result.isError(existingOAuthResult)) {
            return Result.err(existingOAuthResult.error)
        }

        const existingOAuth = existingOAuthResult.value

        logger.info(
            {
                existingOAuth: existingOAuth !== undefined,
                oauthId: existingOAuth?.id,
            },
            'oauth account lookup',
        )

        let userId: bigint
        let sessionToken: string

        if (existingOAuth !== undefined) {
            // Returning user
            userId = existingOAuth.userId
            logger.info({ userId: String(userId) }, 'oauth returning user')

            const returningUserResult = await tryInternal(
                () => userRepository.findById(userId),
                'Failed to load user',
            )
            if (Result.isError(returningUserResult)) {
                return Result.err(returningUserResult.error)
            }

            const returningUser = returningUserResult.value
            if (returningUser === undefined) {
                return Result.err(notFound('User', 'User not found'))
            }
            sessionToken = returningUser.sessionToken
        } else {
            // Check if user with this email already exists
            const existingUserResult = await tryInternal(
                () => userRepository.findByEmail(userInfo.email),
                'Failed to load user by email',
            )
            if (Result.isError(existingUserResult)) {
                return Result.err(existingUserResult.error)
            }

            const existingUser = existingUserResult.value

            logger.info(
                {
                    existingUser: existingUser !== undefined,
                    userId: existingUser !== undefined ? String(existingUser.id) : null,
                },
                'oauth user by email lookup',
            )

            if (existingUser !== undefined && !userInfo.emailVerified) {
                // Someone could register the victim's address at a provider that does
                // not confirm it; linking would hand them the existing account.
                logger.warn({ provider }, 'oauth link refused: email not verified by provider')
                return Result.err(
                    conflict(
                        'An account with this email already exists. Sign in with your password.',
                        OAUTH_EMAIL_UNVERIFIED,
                    ),
                )
            }

            if (existingUser !== undefined) {
                // Link OAuth account to existing user
                userId = existingUser.id
                sessionToken = existingUser.sessionToken
                logger.info({ userId: String(userId) }, 'oauth linking to existing user')
                const createOAuthLinkResult = await tryInternal(
                    () =>
                        oauthAccountRepository.create({
                            userId,
                            provider,
                            providerUserId: userInfo.id,
                            providerEmail: userInfo.email,
                            providerName: userInfo.name,
                            providerAvatar: userInfo.avatar,
                        }),
                    'Failed to link OAuth account',
                )
                if (Result.isError(createOAuthLinkResult)) {
                    return Result.err(createOAuthLinkResult.error)
                }
            } else {
                // Create new user (no password)
                logger.info({ email: maskEmailForLogs(userInfo.email) }, 'oauth creating new user')
                const newUserResult = await tryInternal(
                    () =>
                        userRepository.create({
                            name: userInfo.name,
                            email: userInfo.email,
                            password: null,
                            avatar: userInfo.avatar,
                            ...(userInfo.emailVerified ? { emailVerifiedAt: new Date() } : {}),
                        }),
                    'Failed to create user',
                )
                if (Result.isError(newUserResult)) {
                    return Result.err(newUserResult.error)
                }

                const newUser = newUserResult.value
                userId = newUser.id
                sessionToken = newUser.sessionToken
                logger.info({ userId: String(userId) }, 'oauth new user created')
                const createOAuthAccountResult = await tryInternal(
                    () =>
                        oauthAccountRepository.create({
                            userId: newUser.id,
                            provider,
                            providerUserId: userInfo.id,
                            providerEmail: userInfo.email,
                            providerName: userInfo.name,
                            providerAvatar: userInfo.avatar,
                        }),
                    'Failed to create OAuth account',
                )
                if (Result.isError(createOAuthAccountResult)) {
                    return Result.err(createOAuthAccountResult.error)
                }
            }
        }

        const loginResult = await tryInternal(
            () => auth.login(String(userId), sessionToken),
            'Failed to log in user',
        )
        if (Result.isError(loginResult)) {
            return Result.err(loginResult.error)
        }

        userNotificationService.security(userId, 'new_sign_in')
        return Result.ok({ redirectUrl: oauthConfig.frontendSuccessUrl })
    },
}
