import { Google, Facebook, GitHub, GitLab, generateState, generateCodeVerifier } from 'arctic'
import oauthConfig from '#config/oauth.js'
import appConfig from '#config/app.js'
import {
    oauthAccountRepository,
    oauthLinkVerificationRepository,
    userRepository,
    withTransaction,
} from '#app/repositories/index.js'
import type { UserRow } from '#app/repositories/index.js'
import { isUniqueViolation } from '#app/repositories/db-errors.js'
import { Result } from 'better-result'
import {
    badRequest,
    conflict,
    forbidden,
    notFound,
    type AppError,
    type AppResult,
} from '#app/services/shared/errors.js'
import {
    addressMatches,
    claimLocked,
    destroySessionsQuietly,
} from '#app/services/auth/account-claim-service.js'
import { emailVerificationService } from '#app/services/auth/email-verification-service.js'
import { enforceEmailLinkThrottles } from '#app/services/auth/enforce-throttle.js'
import {
    findUsableToken,
    hashToken,
    issueTokenLocked,
    runTokenTransaction,
} from '#app/services/auth/one-time-token.js'
import { emailService } from '#app/services/notifications/email-service.js'
import { renderBrandedEmail } from '#app/services/notifications/email-templates.js'
import type { Auth } from '#vendor/types/types.js'
import logger from '#vendor/utils/logger.js'
import { normalizeEmail } from '#app/services/auth/auth-normalize.js'
import { maskEmailForLogs } from '#vendor/utils/helpers/mask-sensitive.js'
import { safeEqual } from '#vendor/utils/helpers/safe-equal.js'
import { userNotificationService } from '#app/services/notifications/user-notification-service.js'

type JsonObject = Record<string, unknown>

// The provider's JSON answer, typed by the caller: it is only as trustworthy as the provider, so
// every use reads the fields it needs defensively.
async function fetchJson<T>(url: string, headers?: Record<string, string>): Promise<T> {
    const response = await fetch(url, headers !== undefined ? { headers } : undefined)
    // feat-108: an error answer (expired token, rate limit, outage) is JSON too; read as a
    // profile it gives an empty id. The callback turns the throw into a failed sign-in.
    if (!response.ok) {
        throw new Error(
            `OAuth provider answered ${String(response.status)} for ${new URL(url).host}`,
        )
    }

    const data = await (response as unknown as { json(): Promise<unknown> }).json()
    return data as T
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

// feat-097: the reasons a callback or a link confirmation can end with.
export const OAUTH_LINK_REVOKED = 'oauth_link_revoked'
export const OAUTH_LINK_WRONG_SESSION = 'oauth_link_wrong_session'
export const OAUTH_ALREADY_LINKED = 'oauth_already_linked'
export const EMAIL_CHANGED = 'email_changed'
// feat-098: a mail budget of the address or the account is spent.
export const TOO_MANY_ATTEMPTS = 'too_many_attempts'

const OAUTH_LINK_TTL_MS = 30 * 60 * 1000

function buildOAuthLinkUrl(token: string): string {
    return `${appConfig.frontendUrl}/oauth/link/confirm?token=${encodeURIComponent(token)}`
}

const PROVIDER_TITLES: Record<string, string> = {
    google: 'Google',
    facebook: 'Facebook',
    github: 'GitHub',
    gitlab: 'GitLab',
}

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
    /**
     * feat-097: `authoritative` only when the provider is the authority for the mailbox
     * itself (Google for Gmail and for a Workspace domain, see `googleEmailTrust`). Every
     * other address, even one a provider calls verified, is proven by a mailed link.
     */
    emailTrust: 'authoritative' | 'unverified'
}

/**
 * Google is the authority for an address only when it hosts the mailbox: Gmail, or a
 * Google Workspace domain (`hd` equal to the address's domain), and only with
 * `verified_email`. For any other address `verified_email` says Google checked it once, not
 * that the person owns it now (https://developers.google.com/identity/gsi/web/guides/verify-google-id-token).
 */
export function googleEmailTrust(data: {
    email: string
    verifiedEmail: unknown
    hd: unknown
}): OAuthUserInfo['emailTrust'] {
    if (data.verifiedEmail !== true || data.email === '') return 'unverified'
    const at = data.email.lastIndexOf('@')
    if (at === -1) return 'unverified'
    const domain = data.email.slice(at + 1).toLowerCase()
    if (domain === 'gmail.com' || domain === 'googlemail.com') return 'authoritative'
    return typeof data.hd === 'string' && data.hd !== '' && data.hd.toLowerCase() === domain
        ? 'authoritative'
        : 'unverified'
}

async function fetchGoogleUserInfo(accessToken: string): Promise<OAuthUserInfo> {
    const data = await fetchJson<JsonObject>('https://www.googleapis.com/oauth2/v2/userinfo', {
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
        emailTrust: googleEmailTrust({
            email: typeof data['email'] === 'string' ? data['email'] : '',
            verifiedEmail: data['verified_email'],
            hd: data['hd'],
        }),
    }
}

async function fetchFacebookUserInfo(accessToken: string): Promise<OAuthUserInfo> {
    // The token goes in the header: in the query string it lands in proxy and CDN logs and
    // in Referer headers.
    const data = await fetchJson<JsonObject>(
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
        emailTrust: 'unverified',
    }
}

async function fetchGitHubUserInfo(accessToken: string): Promise<OAuthUserInfo> {
    const headers = { Authorization: `Bearer ${accessToken}` }
    const data = await fetchJson<JsonObject>('https://api.github.com/user', headers)

    // The public `email` of /user is not guaranteed to be verified, so the address
    // always comes from /user/emails: the primary one, and only when verified.
    const answer = await fetchJson<unknown>('https://api.github.com/user/emails', headers)
    const emails = Array.isArray(answer) ? (answer as JsonObject[]) : []
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
        // A verified primary address picks which address to mail; it is not a proof (feat-097).
        emailTrust: 'unverified',
    }
}

async function fetchGitLabUserInfo(accessToken: string): Promise<OAuthUserInfo> {
    const headers = { Authorization: `Bearer ${accessToken}` }
    const data = await fetchJson<JsonObject>('https://gitlab.com/api/v4/user', headers)
    // /api/v4/user has no verification flag; the OIDC userinfo endpoint does (needs the
    // `openid email` scopes). The address GitLab verified is the one to mail, when there is one.
    const userinfo = await fetchJson<JsonObject>('https://gitlab.com/oauth/userinfo', headers)
    const profileEmail = typeof data['email'] === 'string' ? data['email'] : ''
    const email =
        userinfo['email_verified'] === true && typeof userinfo['email'] === 'string'
            ? userinfo['email']
            : profileEmail
    return {
        id:
            typeof data['id'] === 'string' || typeof data['id'] === 'number'
                ? String(data['id'])
                : '',
        email,
        name: typeof data['name'] === 'string' ? data['name'] : '',
        avatar: typeof data['avatar_url'] === 'string' ? data['avatar_url'] : null,
        // The OIDC flag only picks the address; it is proven by mail (feat-097).
        emailTrust: 'unverified',
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
        sessionId: string | null,
    ): Promise<AppResult<{ redirectUrl: string }>> {
        if (!isValidProvider(provider)) {
            return Result.err(badRequest(`Unsupported provider: ${provider}`))
        }
        if (!isProviderConfigured(provider)) {
            return Result.err(notFound('OAuthProvider', `Provider not configured: ${provider}`))
        }

        // Constant time, like every other secret comparison here.
        if (!safeEqual(storedState, receivedState)) {
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

        // feat-108: an account is found by (provider, provider_user_id); an empty id would be one
        // shared account for every profile the provider failed to describe.
        if (userInfo.id === '') {
            logger.warn({ provider }, 'oauth provider returned no user id')
            return Result.err(badRequest('Could not retrieve account id from provider'))
        }

        if (userInfo.email === '') {
            logger.warn({ provider }, 'oauth provider returned empty email')
            return Result.err(badRequest('Could not retrieve email from provider'))
        }

        userInfo.email = normalizeEmail(userInfo.email)

        const identity: OAuthIdentity = {
            provider,
            providerUserId: userInfo.id,
            providerEmail: userInfo.email,
            providerName: userInfo.name,
            providerAvatar: userInfo.avatar,
        }

        return await signInWithIdentity(auth, identity, userInfo.emailTrust, sessionId)
    },

    /**
     * Confirms a mailed OAuth link (feat-097). Only from the browser session that started the
     * sign-in; the account's address must still be the one the link was mailed to. On an
     * account whose address was never verified this is a claim (`claimLocked`).
     */
    async confirmLink(
        token: string,
        auth: Auth,
        sessionId: string | null,
    ): Promise<AppResult<{ status: 'success' }>> {
        const used = badRequest('This link has already been used', 'used_token')
        const expired = badRequest('This link has expired', 'expired_token')
        const found = await findUsableToken(oauthLinkVerificationRepository, token.trim(), {
            used,
            expired,
        })
        if (Result.isError(found)) return Result.err(found.error)
        const verification = found.value
        if (verification === undefined) {
            return Result.err(badRequest('This link is invalid', 'invalid_token'))
        }
        // Not consumed on a wrong session: the owner can still open it in the right browser.
        if (
            sessionId === null ||
            !safeEqual(hashToken(sessionId), verification.sessionBindingHash)
        ) {
            return Result.err(
                forbidden(
                    'Open this link in the browser where you started signing in',
                    OAUTH_LINK_WRONG_SESSION,
                ),
            )
        }

        let outcome: Awaited<
            ReturnType<typeof runTokenTransaction<typeof verification, never, ClaimedLink>>
        >
        try {
            outcome = await runTokenTransaction(oauthLinkVerificationRepository, verification, {
                check: (user) =>
                    addressMatches(user, verification.targetEmail)
                        ? Result.ok(undefined)
                        : Result.err(emailChanged()),
                apply: async (user, tx) => {
                    const claim = await claimLocked(tx, user)
                    await oauthAccountRepository.create(
                        {
                            userId: user.id,
                            provider: verification.provider,
                            providerUserId: verification.providerUserId,
                            providerEmail: verification.providerEmail,
                            providerName: verification.providerName,
                            providerAvatar: verification.providerAvatar,
                        },
                        tx,
                    )
                    return {
                        claimed: claim.claimed,
                        sessionToken: claim.user.sessionToken,
                        previousSessionToken: claim.previousSessionToken,
                    }
                },
            })
        } catch (err: unknown) {
            if (isUniqueViolation(err)) return Result.err(alreadyLinked())
            throw err
        }

        switch (outcome.kind) {
            case 'user_missing':
                return Result.err(notFound('User', 'User not found'))
            case 'unusable':
                return Result.err(outcome.reason === 'expired' ? expired : used)
            case 'rejected':
                return Result.err(outcome.error)
            case 'applied':
                break
        }

        const linked = outcome.value
        if (linked.claimed) {
            await destroySessionsQuietly(linked.previousSessionToken, verification.userId)
        }
        const loggedIn = await auth.login(String(verification.userId), linked.sessionToken)
        if (!loggedIn) return Result.err(badRequest('Failed to sign in'))
        userNotificationService.security(
            verification.userId,
            linked.claimed ? 'account_claimed' : 'new_sign_in',
        )
        return Result.ok({ status: 'success' })
    },

    /**
     * Sends the link that confirms the address of an account without one again (feat-097).
     * The address is the one an OAuth provider showed for this account; nothing is typed.
     */
    async resendFirstEmailLink(
        userId: bigint,
        presentedSessionToken: string | undefined,
    ): Promise<AppResult<{ message: string }>> {
        const accounts = await oauthAccountRepository.findByUserId(userId)
        const providerEmail = accounts
            .map((account) => account.providerEmail)
            .find((email): email is string => email !== null && email !== '')
        if (providerEmail === undefined) {
            return Result.err(badRequest('There is no address to confirm', 'no_pending_email'))
        }
        const email = normalizeEmail(providerEmail)
        const throttled = await enforceEmailLinkThrottles(email, userId, tooManyLinkMails())
        if (Result.isError(throttled)) return Result.err(throttled.error)
        if (await userRepository.emailExistsForOtherUser(email, userId)) {
            return Result.err(conflict('Email is already linked to another account'))
        }
        return await emailVerificationService.sendLinkVerificationEmail(
            userId,
            email,
            presentedSessionToken,
        )
    },
}

interface OAuthIdentity {
    provider: OAuthProvider
    providerUserId: string
    providerEmail: string
    providerName: string
    providerAvatar: string | null
}

interface ClaimedLink {
    claimed: boolean
    sessionToken: string
    previousSessionToken: string
}

const emailChanged = (): AppError =>
    conflict('The account email changed after this sign-in started', EMAIL_CHANGED)
const alreadyLinked = (): AppError =>
    conflict('This sign-in method is already linked to an account', OAUTH_ALREADY_LINKED)
const tooManyLinkMails = (): AppError =>
    badRequest('Too many emails were sent. Please try again later.', TOO_MANY_ATTEMPTS)

async function finishSignIn(
    auth: Auth,
    userId: bigint,
    sessionToken: string,
): Promise<AppResult<{ redirectUrl: string }>> {
    const loggedIn = await auth.login(String(userId), sessionToken)
    if (!loggedIn) return Result.err(badRequest('Failed to sign in'))
    userNotificationService.security(userId, 'new_sign_in')
    return Result.ok({ redirectUrl: oauthConfig.frontendSuccessUrl })
}

/**
 * Google proved the mailbox (feat-097): link the identity to the account with that address,
 * claiming the account if its address was never verified. One transaction under the user's
 * row lock; the address is checked again under it.
 */
async function linkTrusted(
    auth: Auth,
    userId: bigint,
    identity: OAuthIdentity,
): Promise<AppResult<{ redirectUrl: string }>> {
    let linked: { kind: 'missing' } | { kind: 'changed' } | ({ kind: 'ok' } & ClaimedLink)
    try {
        linked = await withTransaction(async (tx) => {
            const user = await userRepository.lockById(userId, tx)
            if (user === undefined) return { kind: 'missing' as const }
            if (!addressMatches(user, identity.providerEmail)) return { kind: 'changed' as const }
            const claim = await claimLocked(tx, user)
            await oauthAccountRepository.create({ userId: user.id, ...identity }, tx)
            return {
                kind: 'ok' as const,
                claimed: claim.claimed,
                sessionToken: claim.user.sessionToken,
                previousSessionToken: claim.previousSessionToken,
            }
        })
    } catch (err: unknown) {
        if (isUniqueViolation(err)) return Result.err(alreadyLinked())
        throw err
    }
    if (linked.kind === 'missing') return Result.err(notFound('User', 'User not found'))
    if (linked.kind === 'changed') return Result.err(emailChanged())

    if (linked.claimed) {
        await destroySessionsQuietly(linked.previousSessionToken, userId)
        userNotificationService.security(userId, 'account_claimed')
    }
    return await finishSignIn(auth, userId, linked.sessionToken)
}

/**
 * Another provider showed the address of an existing account (feat-097): nothing is linked
 * and nobody is signed in. The account's address gets a link that works only in this browser
 * session, and only while the account still has that address.
 */
async function startMailedLink(
    userId: bigint,
    identity: OAuthIdentity,
    sessionId: string | null,
): Promise<AppResult<{ redirectUrl: string }>> {
    if (sessionId === null) {
        return Result.err(badRequest('OAuth sign-in requires a session'))
    }
    // feat-098: the same mail budgets as linking an address from the account page, before
    // the token: a spent budget neither mails nor cancels the owner's pending link.
    const throttled = await enforceEmailLinkThrottles(
        identity.providerEmail,
        userId,
        tooManyLinkMails(),
    )
    if (Result.isError(throttled)) return Result.err(throttled.error)
    const issued = await issueTokenLocked(oauthLinkVerificationRepository, {
        userId,
        ttlMs: OAUTH_LINK_TTL_MS,
        check: (user) =>
            addressMatches(user, identity.providerEmail)
                ? Result.ok(undefined)
                : Result.err(emailChanged()),
        // A pending GitHub link does not cancel a pending GitLab one.
        invalidatePending: (tx) =>
            oauthLinkVerificationRepository.invalidatePendingByUserIdAndProvider(
                userId,
                identity.provider,
                tx,
            ),
        extra: (user) => ({
            provider: identity.provider,
            providerUserId: identity.providerUserId,
            providerEmail: identity.providerEmail,
            providerName: identity.providerName,
            providerAvatar: identity.providerAvatar,
            targetEmail: user.email ?? identity.providerEmail,
            sessionBindingHash: hashToken(sessionId),
        }),
    })
    if (Result.isError(issued)) return Result.err(issued.error)

    const { rawToken, user } = issued.value
    const providerTitle = PROVIDER_TITLES[identity.provider] ?? identity.provider
    const url = buildOAuthLinkUrl(rawToken)
    const content = renderBrandedEmail({
        subject: `Link ${providerTitle} to your account`,
        eyebrow: 'Sign-in method',
        title: `Link ${providerTitle} to your account`,
        name: user.name,
        intro: `Somebody signed in with the ${providerTitle} account "${identity.providerName}" that uses this email address. Open the link in the same browser to link it to your Vibe Template account.`,
        action: { kind: 'button', label: `Link ${providerTitle}`, url },
        footer: 'This link expires in 30 minutes and works only in the browser where the sign-in started. If it was not you, ignore this email: nothing is linked without it.',
        textLines: [
            `Somebody signed in with the ${providerTitle} account "${identity.providerName}" that uses this email address.`,
            'To link it to your Vibe Template account, open this link in the same browser:',
            url,
            '',
            'This link expires in 30 minutes. If it was not you, ignore this email.',
        ],
    })
    const sent = await emailService.send({
        to: user.email ?? identity.providerEmail,
        subject: content.subject,
        text: content.text,
        html: content.html,
    })
    if (Result.isError(sent)) return Result.err(sent.error)

    logger.info({ userId: String(userId), provider: identity.provider }, 'oauth link mailed')
    return Result.ok({ redirectUrl: oauthConfig.frontendLinkPendingUrl })
}

/**
 * What a callback does with the provider's identity (feat-097): sign in by its link, link it
 * to the account with its address, or create an account for it. A new account and its first
 * link are one transaction (feat-098): when a concurrent callback for the same identity
 * commits first, the unique link rolls this one back with its user, and the decision is made
 * once more, now finding the winner's link.
 */
async function signInWithIdentity(
    auth: Auth,
    identity: OAuthIdentity,
    emailTrust: OAuthUserInfo['emailTrust'],
    sessionId: string | null,
    isRetry = false,
): Promise<AppResult<{ redirectUrl: string }>> {
    const { provider, providerUserId, providerEmail } = identity
    const existingOAuth = await oauthAccountRepository.findByProviderAndProviderId(
        provider,
        providerUserId,
    )
    logger.info({ existingOAuth: existingOAuth !== undefined }, 'oauth account lookup')

    if (existingOAuth !== undefined) {
        // feat-097: the link and the sessionToken are read again under the user's row
        // lock, the lock a claim takes. Either the claim removed the link (seen here), or
        // the token read here is the one a later claim rotates away (ADR 0002).
        const signIn = await withTransaction(async (tx) => {
            const user = await userRepository.lockById(existingOAuth.userId, tx)
            if (user === undefined) return { kind: 'missing' as const }
            const link = await oauthAccountRepository.findLinkForUser(
                provider,
                providerUserId,
                user.id,
                tx,
            )
            if (link === undefined) return { kind: 'revoked' as const }
            return { kind: 'ok' as const, sessionToken: user.sessionToken }
        })
        if (signIn.kind === 'missing') return Result.err(notFound('User', 'User not found'))
        if (signIn.kind === 'revoked') {
            return Result.err(
                badRequest('This sign-in method was removed from the account', OAUTH_LINK_REVOKED),
            )
        }
        return await finishSignIn(auth, existingOAuth.userId, signIn.sessionToken)
    }

    const existingUser = await userRepository.findByEmail(providerEmail)
    logger.info(
        {
            existingUser: existingUser !== undefined,
            emailTrust,
            userId: existingUser !== undefined ? String(existingUser.id) : null,
        },
        'oauth user by email lookup',
    )

    if (existingUser !== undefined) {
        if (emailTrust === 'authoritative') {
            return await linkTrusted(auth, existingUser.id, identity)
        }
        // Any other provider: the account's owner confirms the link by mail, from this
        // browser session (feat-097).
        return await startMailedLink(existingUser.id, identity, sessionId)
    }

    // feat-097: an address the provider does not prove is not written to users.email: the
    // account is created without one (the address stays in oauth_accounts) and gets it when
    // its owner confirms the mailed link from a session of this account.
    const authoritative = emailTrust === 'authoritative'
    logger.info(
        { email: maskEmailForLogs(providerEmail), authoritative },
        'oauth creating new user',
    )
    let newUser: UserRow
    try {
        newUser = await withTransaction(async (tx) => {
            const created = await userRepository.create(
                {
                    name: identity.providerName,
                    email: authoritative ? providerEmail : null,
                    password: null,
                    avatar: identity.providerAvatar,
                    ...(authoritative ? { emailVerifiedAt: new Date() } : {}),
                },
                tx,
            )
            await oauthAccountRepository.create({ userId: created.id, ...identity }, tx)
            return created
        })
    } catch (err: unknown) {
        // The link (or, for Google, the address) was taken by a concurrent callback.
        if (isUniqueViolation(err) && !isRetry) {
            logger.info({ provider }, 'oauth new user lost a race, deciding again')
            return await signInWithIdentity(auth, identity, emailTrust, sessionId, true)
        }
        throw err
    }

    const signedIn = await finishSignIn(auth, newUser.id, newUser.sessionToken)
    if (Result.isOk(signedIn) && !authoritative) {
        await sendFirstEmailLinkQuietly(newUser.id, providerEmail, newUser.sessionToken)
    }
    return signedIn
}

/** The first address of a new account goes out after sign-in; a failure only logs. */
async function sendFirstEmailLinkQuietly(
    userId: bigint,
    email: string,
    sessionToken: string,
): Promise<void> {
    try {
        // feat-098: the mail budgets apply to the first mail too; a spent one only skips it.
        const throttled = await enforceEmailLinkThrottles(email, userId, tooManyLinkMails())
        if (Result.isError(throttled)) {
            logger.warn({ userId: String(userId) }, 'first email link throttled')
            return
        }
        const sent = await emailVerificationService.sendLinkVerificationEmail(
            userId,
            email,
            sessionToken,
        )
        if (Result.isError(sent)) {
            logger.warn({ userId: String(userId) }, 'first email link not sent')
        }
    } catch (err: unknown) {
        logger.warn({ err, userId: String(userId) }, 'first email link not sent')
    }
}
