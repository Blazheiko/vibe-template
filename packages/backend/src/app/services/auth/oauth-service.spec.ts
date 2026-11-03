import { createHash } from 'node:crypto'
import { Result } from 'better-result'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const userRepositoryMock = {
    findById: vi.fn(),
    findByEmail: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    lockById: vi.fn(),
    emailExistsForOtherUser: vi.fn(),
}

const oauthAccountRepositoryMock = {
    findByProviderAndProviderId: vi.fn(),
    findLinkForUser: vi.fn(),
    findByUserId: vi.fn(),
    create: vi.fn(),
}

const oauthLinkVerificationRepositoryMock = {
    create: vi.fn(),
    findByTokenHash: vi.fn(),
    invalidatePendingByUserId: vi.fn(),
    invalidatePendingByUserIdAndProvider: vi.fn(),
    markUsed: vi.fn(),
    burn: vi.fn(),
}

const claimLockedMock = vi.fn()
const destroySessionsQuietlyMock = vi.fn()
const sendLinkVerificationEmailMock = vi.fn()
const emailServiceMock = { send: vi.fn() }
const securityMock = vi.fn()
const enforceEmailLinkThrottlesMock = vi.fn()

const authMock = {
    login: vi.fn(),
}

const loggerMock = {
    info: vi.fn(),
    warn: vi.fn(),
}

// A stand-in for the transaction `withTransaction` hands to the repositories; the real
// commit/rollback behaviour is proved against PostgreSQL (*.pg.test.ts).
const TX = vi.hoisted(() => ({ transaction: true }))

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
        frontendLinkPendingUrl: 'https://app.example.com/?oauth=link_pending',
    },
}))

vi.mock('#app/repositories/index.js', () => ({
    userRepository: userRepositoryMock,
    oauthAccountRepository: oauthAccountRepositoryMock,
    oauthLinkVerificationRepository: oauthLinkVerificationRepositoryMock,
    withTransaction: <T>(work: (tx: unknown) => Promise<T>): Promise<T> => work(TX),
}))

// The claim itself is covered by account-claim-service.spec.ts; here only what the OAuth
// flows do with it. `addressMatches` keeps its rule (case and spaces do not count).
vi.mock('#app/services/auth/account-claim-service.js', () => ({
    addressMatches: (user: { email: string | null }, proven: string) =>
        user.email !== null && user.email.trim().toLowerCase() === proven.trim().toLowerCase(),
    claimLocked: claimLockedMock,
    destroySessionsQuietly: destroySessionsQuietlyMock,
}))

vi.mock('#app/services/auth/email-verification-service.js', () => ({
    emailVerificationService: { sendLinkVerificationEmail: sendLinkVerificationEmailMock },
}))

// The budgets themselves are covered by enforce-throttle.spec.ts and the Redis tests.
vi.mock('#app/services/auth/enforce-throttle.js', () => ({
    enforceEmailLinkThrottles: enforceEmailLinkThrottlesMock,
}))

vi.mock('#app/services/notifications/email-service.js', () => ({ emailService: emailServiceMock }))

vi.mock('#app/services/notifications/user-notification-service.js', () => ({
    userNotificationService: { security: securityMock },
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

const originalEnv = { ...process.env }

async function loadOauthService() {
    process.env['FRONTEND_URL'] = 'https://app.example.com'
    process.env['APP_URL'] = 'https://app.example.com'
    return import('./oauth-service.js')
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

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

/** A Google profile; `verified_email` true unless given. */
function stubGoogle(profile: Record<string, unknown>): void {
    googleValidateAuthorizationCodeMock.mockResolvedValue(tokens('google-token'))
    stubFetch({
        'https://www.googleapis.com/oauth2/v2/userinfo': {
            id: 'g-1',
            name: 'Jane',
            verified_email: true,
            ...profile,
        },
    })
}

function stubGitHub(): void {
    githubValidateAuthorizationCodeMock.mockResolvedValue(tokens('github-access-token'))
    stubGitHubUserInfoFetch()
}

// JSON with bigint ids, for searching a mock's calls for a string.
const serialize = (value: unknown): string =>
    JSON.stringify(value, (_key, item: unknown) => (typeof item === 'bigint' ? String(item) : item))

const tokens = (accessToken: string) => ({
    accessToken: () => accessToken,
    hasRefreshToken: () => false,
    refreshToken: () => null,
})

const SESSION_ID = 'browser-session-1'

async function callback(provider: string, sessionId: string | null = SESSION_ID) {
    const { oauthService } = await loadOauthService()
    return oauthService.handleCallback(
        provider,
        'oauth-code',
        'oauth-state',
        'oauth-state',
        provider === 'google' ? 'code-verifier' : null,
        authMock as never,
        sessionId,
    )
}

type CallbackResult = Awaited<ReturnType<typeof callback>>

const order = (fn: { mock: { invocationCallOrder: number[] } }): number =>
    fn.mock.invocationCallOrder[0]!

/** An account row as `lockById` returns it. */
const account = (over: Record<string, unknown> = {}) => ({
    id: 5n,
    name: 'Account Owner',
    email: 'user@example.com',
    emailVerifiedAt: new Date('2026-01-01T00:00:00Z'),
    sessionToken: 'existing-token',
    ...over,
})

// The identity is linked already: the link is read again under the user's lock.
function givenExistingLink(user: Record<string, unknown> | null = { id: 7n }): void {
    oauthAccountRepositoryMock.findByProviderAndProviderId.mockResolvedValue({
        id: 21n,
        userId: 7n,
    })
    userRepositoryMock.lockById.mockResolvedValue(
        user === null ? undefined : { sessionToken: 'session-token', ...user },
    )
    oauthAccountRepositoryMock.findLinkForUser.mockResolvedValue({ id: 21n, userId: 7n })
    authMock.login.mockResolvedValue(true)
}

// No OAuth link yet, but a user with the same email already exists.
function givenExistingUserByEmail(over: Record<string, unknown> = {}): void {
    oauthAccountRepositoryMock.findByProviderAndProviderId.mockResolvedValue(undefined)
    userRepositoryMock.findByEmail.mockResolvedValue(account())
    userRepositoryMock.lockById.mockResolvedValue(account(over))
    oauthAccountRepositoryMock.create.mockResolvedValue({ id: 30n, userId: 5n })
    oauthLinkVerificationRepositoryMock.invalidatePendingByUserIdAndProvider.mockResolvedValue(0)
    oauthLinkVerificationRepositoryMock.create.mockResolvedValue({ id: 40n })
    emailServiceMock.send.mockResolvedValue(Result.ok(undefined))
    authMock.login.mockResolvedValue(true)
}

function givenNewUser(): void {
    oauthAccountRepositoryMock.findByProviderAndProviderId.mockResolvedValue(undefined)
    userRepositoryMock.findByEmail.mockResolvedValue(undefined)
    userRepositoryMock.create.mockResolvedValue({ id: 8n, sessionToken: 'new-session-token' })
    oauthAccountRepositoryMock.create.mockResolvedValue({ id: 22n, userId: 8n })
    sendLinkVerificationEmailMock.mockResolvedValue(Result.ok({ message: 'sent' }))
    authMock.login.mockResolvedValue(true)
}

/** `claimLocked` as the account-claim-service answers for the row it is given. */
function claimAnswers(claimed: boolean): void {
    claimLockedMock.mockImplementation((_tx: unknown, user: { sessionToken: string }) =>
        Promise.resolve({
            claimed,
            user: { ...user, sessionToken: claimed ? 'rotated-token' : user.sessionToken },
            previousSessionToken: user.sessionToken,
        }),
    )
}

function expectNoSignIn(): void {
    expect(authMock.login).not.toHaveBeenCalled()
    expect(securityMock).not.toHaveBeenCalled()
}

function expectError(result: CallbackResult | Result<unknown, unknown>, error: object): void {
    expect(Result.isError(result)).toBe(true)
    if (Result.isError(result)) expect(result.error).toMatchObject(error)
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

const THROTTLED = {
    _tag: 'BadRequest',
    message: 'Too many emails were sent. Please try again later.',
    reason: 'too_many_attempts',
}

const spendMailBudget = (): void => {
    enforceEmailLinkThrottlesMock.mockImplementation((_email, _userId, rejected) =>
        Promise.resolve(Result.err(rejected)),
    )
}

beforeEach(() => {
    enforceEmailLinkThrottlesMock.mockResolvedValue(Result.ok(undefined))
    claimAnswers(false)
    destroySessionsQuietlyMock.mockResolvedValue(undefined)
})

afterEach(() => {
    restoreConfig.splice(0).forEach((restore) => {
        restore()
    })
    vi.resetModules()
    vi.resetAllMocks()
    vi.unstubAllGlobals()
    for (const key of Object.keys(process.env)) {
        if (!(key in originalEnv)) delete process.env[key]
    }
    Object.assign(process.env, originalEnv)
})

// feat-097: Google is the authority for a mailbox only when it hosts it.
describe('googleEmailTrust', () => {
    it.each([
        ['Gmail, verified', 'jane@gmail.com', true, undefined, 'authoritative'],
        ['Gmail in capitals, verified', 'Jane@GMAIL.com', true, undefined, 'authoritative'],
        ['googlemail.com, verified', 'jane@googlemail.com', true, undefined, 'authoritative'],
        [
            'Workspace, hd equals the domain',
            'jane@corp.example',
            true,
            'corp.example',
            'authoritative',
        ],
        [
            'Workspace, hd differs in case only',
            'jane@Corp.Example',
            true,
            'CORP.example',
            'authoritative',
        ],
        [
            'Workspace, hd of another domain',
            'jane@corp.example',
            true,
            'other.example',
            'unverified',
        ],
        [
            'Workspace, hd of a subdomain',
            'jane@corp.example',
            true,
            'mail.corp.example',
            'unverified',
        ],
        ['Workspace, empty hd', 'jane@corp.example', true, '', 'unverified'],
        ['Workspace, hd not a string', 'jane@corp.example', true, ['corp.example'], 'unverified'],
        ['a third-party address without hd', 'jane@example.com', true, undefined, 'unverified'],
        ['Gmail with verified_email false', 'jane@gmail.com', false, undefined, 'unverified'],
        ['Gmail without verified_email', 'jane@gmail.com', undefined, undefined, 'unverified'],
        [
            'Gmail with verified_email "true" (string)',
            'jane@gmail.com',
            'true',
            undefined,
            'unverified',
        ],
        [
            'Workspace with verified_email false',
            'jane@corp.example',
            false,
            'corp.example',
            'unverified',
        ],
        [
            'Workspace without verified_email',
            'jane@corp.example',
            undefined,
            'corp.example',
            'unverified',
        ],
        ['an empty address', '', true, undefined, 'unverified'],
        ['an address without @', 'gmail.com', true, 'gmail.com', 'unverified'],
        [
            'gmail.com only as a subdomain',
            'jane@gmail.com.evil.example',
            true,
            undefined,
            'unverified',
        ],
    ])('%s → %s', async (_label, email, verifiedEmail, hd, expected) => {
        const { googleEmailTrust } = await loadOauthService()

        expect(googleEmailTrust({ email, verifiedEmail, hd })).toBe(expected)
    })
})

describe('oauthService.handleCallback', () => {
    // --- the identity is linked already -----------------------------------------------------
    describe('an identity that is linked already', () => {
        it('signs in with the session token read under the user lock', async () => {
            stubGitHub()
            givenExistingLink()

            const result = await callback('github')

            expect(Result.isOk(result) && result.value).toEqual({
                redirectUrl: 'https://app.example.com/oauth/success',
            })
            expect(oauthAccountRepositoryMock.findByProviderAndProviderId).toHaveBeenCalledWith(
                'github',
                'provider-user-1',
            )
            // feat-097: lock the user, then read the link again in the same transaction.
            expect(userRepositoryMock.lockById).toHaveBeenCalledWith(7n, TX)
            expect(oauthAccountRepositoryMock.findLinkForUser).toHaveBeenCalledWith(
                'github',
                'provider-user-1',
                7n,
                TX,
            )
            expect(order(userRepositoryMock.lockById)).toBeLessThan(
                order(oauthAccountRepositoryMock.findLinkForUser),
            )
            expect(authMock.login).toHaveBeenCalledWith('7', 'session-token')
            expect(securityMock).toHaveBeenCalledWith(7n, 'new_sign_in')
            // The provider tokens are used once, to read the profile, and are not kept.
            expect(oauthAccountRepositoryMock).not.toHaveProperty('updateTokens')
            expect(oauthAccountRepositoryMock.create).not.toHaveBeenCalled()
            expect(userRepositoryMock.create).not.toHaveBeenCalled()
            expect(claimLockedMock).not.toHaveBeenCalled()
        })

        it('signs in whatever the provider says about the address', async () => {
            stubGoogle({ email: 'user@example.com', verified_email: false })
            givenExistingLink()

            const result = await callback('google')

            expect(Result.isOk(result)).toBe(true)
            expect(authMock.login).toHaveBeenCalledWith('7', 'session-token')
            expect(userRepositoryMock.findByEmail).not.toHaveBeenCalled()
        })

        it('refuses with oauth_link_revoked when a claim removed the link meanwhile', async () => {
            stubGitHub()
            givenExistingLink()
            oauthAccountRepositoryMock.findLinkForUser.mockResolvedValue(undefined)

            const result = await callback('github')

            expectError(result, {
                _tag: 'BadRequest',
                message: 'This sign-in method was removed from the account',
                reason: 'oauth_link_revoked',
            })
            expectNoSignIn()
            expect(oauthAccountRepositoryMock.create).not.toHaveBeenCalled()
            expect(userRepositoryMock.findByEmail).not.toHaveBeenCalled()
        })

        it('answers not found when the user is gone', async () => {
            stubGitHub()
            givenExistingLink(null)

            const result = await callback('github')

            expectError(result, { _tag: 'NotFound' })
            expect(oauthAccountRepositoryMock.findLinkForUser).not.toHaveBeenCalled()
            expectNoSignIn()
        })

        it('answers when the session cannot be created', async () => {
            stubGitHub()
            givenExistingLink()
            authMock.login.mockResolvedValue(false)

            const result = await callback('github')

            expectError(result, { _tag: 'BadRequest', message: 'Failed to sign in' })
            expect(securityMock).not.toHaveBeenCalled()
        })
    })

    // --- an account has the address, Google is the authority for it --------------------------
    describe('an existing account, Google authoritative', () => {
        it('links a verified account and signs in, without a claim', async () => {
            stubGoogle({ email: 'User@Gmail.com' })
            givenExistingUserByEmail({ email: 'user@gmail.com' })
            userRepositoryMock.findByEmail.mockResolvedValue(account({ email: 'user@gmail.com' }))

            const result = await callback('google')

            expect(Result.isOk(result) && result.value).toEqual({
                redirectUrl: 'https://app.example.com/oauth/success',
            })
            expect(userRepositoryMock.findByEmail).toHaveBeenCalledWith('user@gmail.com')
            expect(userRepositoryMock.lockById).toHaveBeenCalledWith(5n, TX)
            expect(claimLockedMock).toHaveBeenCalledWith(TX, expect.objectContaining({ id: 5n }))
            expect(oauthAccountRepositoryMock.create).toHaveBeenCalledWith(
                {
                    userId: 5n,
                    provider: 'google',
                    providerUserId: 'g-1',
                    providerEmail: 'user@gmail.com',
                    providerName: 'Jane',
                    providerAvatar: null,
                },
                TX,
            )
            expect(order(userRepositoryMock.lockById)).toBeLessThan(order(claimLockedMock))
            expect(order(claimLockedMock)).toBeLessThan(order(oauthAccountRepositoryMock.create))
            expect(destroySessionsQuietlyMock).not.toHaveBeenCalled()
            expect(authMock.login).toHaveBeenCalledWith('5', 'existing-token')
            expect(securityMock).toHaveBeenCalledTimes(1)
            expect(securityMock).toHaveBeenCalledWith(5n, 'new_sign_in')
            // Nothing is mailed: Google proved the mailbox.
            expect(oauthLinkVerificationRepositoryMock.create).not.toHaveBeenCalled()
            expect(emailServiceMock.send).not.toHaveBeenCalled()
        })

        it('reads hd from the Google profile: a Workspace address links directly', async () => {
            stubGoogle({ email: 'user@example.com', hd: 'example.com' })
            givenExistingUserByEmail()

            const result = await callback('google')

            expect(Result.isOk(result)).toBe(true)
            expect(oauthAccountRepositoryMock.create).toHaveBeenCalledWith(
                expect.objectContaining({ userId: 5n, provider: 'google' }),
                TX,
            )
            expect(authMock.login).toHaveBeenCalledWith('5', 'existing-token')
        })

        it('claims an unverified account: old sessions go, the new token signs in', async () => {
            stubGoogle({ email: 'user@gmail.com' })
            givenExistingUserByEmail({ email: 'user@gmail.com', emailVerifiedAt: null })
            claimAnswers(true)

            const result = await callback('google')

            expect(Result.isOk(result)).toBe(true)
            expect(claimLockedMock).toHaveBeenCalledWith(
                TX,
                expect.objectContaining({ id: 5n, emailVerifiedAt: null }),
            )
            expect(oauthAccountRepositoryMock.create).toHaveBeenCalledWith(
                expect.objectContaining({ userId: 5n, provider: 'google' }),
                TX,
            )
            expect(destroySessionsQuietlyMock).toHaveBeenCalledWith('existing-token', 5n)
            expect(securityMock).toHaveBeenCalledWith(5n, 'account_claimed')
            expect(authMock.login).toHaveBeenCalledWith('5', 'rotated-token')
            expect(order(destroySessionsQuietlyMock)).toBeLessThan(order(authMock.login))
        })

        it('refuses with 409 email_changed when the locked account has another address', async () => {
            stubGoogle({ email: 'user@gmail.com' })
            givenExistingUserByEmail({ email: 'changed@gmail.com' })
            userRepositoryMock.findByEmail.mockResolvedValue(account({ email: 'user@gmail.com' }))

            const result = await callback('google')

            expectError(result, {
                _tag: 'Conflict',
                message: 'The account email changed after this sign-in started',
                reason: 'email_changed',
            })
            expect(claimLockedMock).not.toHaveBeenCalled()
            expect(oauthAccountRepositoryMock.create).not.toHaveBeenCalled()
            expectNoSignIn()
        })

        it('refuses with 409 email_changed when the locked account has no address any more', async () => {
            stubGoogle({ email: 'user@gmail.com' })
            givenExistingUserByEmail({ email: null })

            const result = await callback('google')

            expectError(result, { _tag: 'Conflict', reason: 'email_changed' })
            expect(claimLockedMock).not.toHaveBeenCalled()
            expectNoSignIn()
        })

        it('answers 409 oauth_already_linked when the unique index refuses the link', async () => {
            stubGoogle({ email: 'user@gmail.com' })
            givenExistingUserByEmail({ email: 'user@gmail.com', emailVerifiedAt: null })
            claimAnswers(true)
            oauthAccountRepositoryMock.create.mockRejectedValue(
                Object.assign(new Error('duplicate key'), { code: '23505' }),
            )

            const result = await callback('google')

            expectError(result, {
                _tag: 'Conflict',
                message: 'This sign-in method is already linked to an account',
                reason: 'oauth_already_linked',
            })
            // The transaction rolled back: the claim did not happen, nothing to clean up.
            expect(destroySessionsQuietlyMock).not.toHaveBeenCalled()
            expectNoSignIn()
        })

        it('lets any other failure of the link transaction propagate', async () => {
            stubGoogle({ email: 'user@gmail.com' })
            givenExistingUserByEmail({ email: 'user@gmail.com' })
            oauthAccountRepositoryMock.create.mockRejectedValue(new Error('db down'))

            await expect(callback('google')).rejects.toThrow('db down')
            expectNoSignIn()
        })

        it('answers not found when the account is gone by the time of the lock', async () => {
            stubGoogle({ email: 'user@gmail.com' })
            givenExistingUserByEmail()
            userRepositoryMock.lockById.mockResolvedValue(undefined)

            const result = await callback('google')

            expectError(result, { _tag: 'NotFound' })
            expect(claimLockedMock).not.toHaveBeenCalled()
            expectNoSignIn()
        })
    })

    // --- an account has the address, the provider is not the authority ----------------------
    describe('an existing account, any other provider: the link is mailed', () => {
        it.each([
            ['GitHub', 'github'],
            ['Google with a third-party address', 'google'],
            ['Google with verified_email false', 'google-unverified'],
            ['Facebook', 'facebook'],
            ['GitLab with a verified OIDC address', 'gitlab'],
        ])('%s: nothing is linked and nobody is signed in', async (_label, scenario) => {
            if (scenario === 'github') stubGitHub()
            if (scenario === 'google') stubGoogle({ email: 'user@example.com' })
            if (scenario === 'google-unverified') {
                stubGoogle({ email: 'user@gmail.com', verified_email: false })
            }
            if (scenario === 'facebook') {
                facebookValidateAuthorizationCodeMock.mockResolvedValue(tokens('fb-token'))
                stubFetch({
                    'https://graph.facebook.com/me': {
                        id: 'fb-1',
                        email: 'user@example.com',
                        name: 'Jane',
                        verified: true,
                    },
                })
            }
            if (scenario === 'gitlab') {
                gitlabValidateAuthorizationCodeMock.mockResolvedValue(tokens('gl-token'))
                stubFetch({
                    'https://gitlab.com/api/v4/user': { id: 9, email: 'user@example.com' },
                    'https://gitlab.com/oauth/userinfo': {
                        email: 'user@example.com',
                        email_verified: true,
                    },
                })
            }
            givenExistingUserByEmail(
                scenario === 'google-unverified' ? { email: 'user@gmail.com' } : {},
            )

            const result = await callback(scenario.replace('-unverified', ''))

            expect(Result.isOk(result) && result.value).toEqual({
                redirectUrl: 'https://app.example.com/?oauth=link_pending',
            })
            expect(oauthLinkVerificationRepositoryMock.create).toHaveBeenCalledTimes(1)
            expect(emailServiceMock.send).toHaveBeenCalledTimes(1)
            expect(oauthAccountRepositoryMock.create).not.toHaveBeenCalled()
            expect(userRepositoryMock.create).not.toHaveBeenCalled()
            expect(claimLockedMock).not.toHaveBeenCalled()
            expectNoSignIn()
        })

        it('consumes the mail budgets of the address and the account before the token', async () => {
            stubGitHub()
            givenExistingUserByEmail()

            await callback('github')

            expect(enforceEmailLinkThrottlesMock).toHaveBeenCalledWith(
                'user@example.com',
                5n,
                THROTTLED,
            )
            expect(order(enforceEmailLinkThrottlesMock)).toBeLessThan(
                order(oauthLinkVerificationRepositoryMock.create),
            )
        })

        it('a spent mail budget: 400 too_many_attempts, no token, no mail, no pending link retired', async () => {
            stubGitHub()
            givenExistingUserByEmail()
            spendMailBudget()

            const result = await callback('github')

            expectError(result, THROTTLED)
            expect(userRepositoryMock.lockById).not.toHaveBeenCalled()
            expect(
                oauthLinkVerificationRepositoryMock.invalidatePendingByUserIdAndProvider,
            ).not.toHaveBeenCalled()
            expect(oauthLinkVerificationRepositoryMock.create).not.toHaveBeenCalled()
            expect(emailServiceMock.send).not.toHaveBeenCalled()
            expectNoSignIn()
        })

        it('binds the link to the browser session and retires only this provider pending links', async () => {
            stubGitHub()
            givenExistingUserByEmail()

            const result = await callback('github')

            expect(Result.isOk(result)).toBe(true)
            expect(userRepositoryMock.lockById).toHaveBeenCalledWith(5n, TX)
            expect(
                oauthLinkVerificationRepositoryMock.invalidatePendingByUserIdAndProvider,
            ).toHaveBeenCalledWith(5n, 'github', TX)
            // A pending GitHub link does not cancel a pending GitLab one.
            expect(
                oauthLinkVerificationRepositoryMock.invalidatePendingByUserId,
            ).not.toHaveBeenCalled()

            const [created, executor] = oauthLinkVerificationRepositoryMock.create.mock
                .calls[0] as [Record<string, unknown>, unknown]
            expect(executor).toBe(TX)
            expect(created).toEqual({
                userId: 5n,
                provider: 'github',
                providerUserId: 'provider-user-1',
                providerEmail: 'user@example.com',
                providerName: 'Jane',
                providerAvatar: 'https://cdn.example.com/avatar.png',
                targetEmail: 'user@example.com',
                sessionBindingHash: sha256(SESSION_ID),
                tokenHash: expect.stringMatching(/^[0-9a-f]{64}$/),
                expiresAt: expect.any(Date),
            })
            // Only hashes are stored: neither the session id nor the mailed token.
            expect(serialize(created)).not.toContain(SESSION_ID)
            const ttl = (created['expiresAt'] as Date).getTime() - Date.now()
            expect(ttl).toBeGreaterThan(29 * 60_000)
            expect(ttl).toBeLessThanOrEqual(30 * 60_000)

            const mail = emailServiceMock.send.mock.calls[0]![0] as {
                to: string
                subject: string
                text: string
                html: string
            }
            expect(mail.to).toBe('user@example.com')
            expect(mail.subject).toBe('Link GitHub to your account')
            const raw = /\/oauth\/link\/confirm\?token=([\w-]+)/.exec(mail.text)![1]!
            expect(sha256(decodeURIComponent(raw))).toBe(created['tokenHash'])
            expect(mail.text).toContain('https://app.example.com/oauth/link/confirm?token=')
            expect(mail.html).toContain('Account Owner')
            expect(order(oauthLinkVerificationRepositoryMock.create)).toBeLessThan(
                order(emailServiceMock.send),
            )
        })

        it('mails the address of the locked account row', async () => {
            stubGitHub()
            givenExistingUserByEmail({ email: 'User@Example.com' })

            await callback('github')

            expect(oauthLinkVerificationRepositoryMock.create).toHaveBeenCalledWith(
                expect.objectContaining({ targetEmail: 'User@Example.com' }),
                TX,
            )
            expect(emailServiceMock.send).toHaveBeenCalledWith(
                expect.objectContaining({ to: 'User@Example.com' }),
            )
        })

        it('mails an unverified account the same way (the confirmation is the claim)', async () => {
            stubGitHub()
            givenExistingUserByEmail({ emailVerifiedAt: null })

            const result = await callback('github')

            expect(Result.isOk(result) && result.value).toEqual({
                redirectUrl: 'https://app.example.com/?oauth=link_pending',
            })
            expect(claimLockedMock).not.toHaveBeenCalled()
            expectNoSignIn()
        })

        it('refuses without a browser session: 400, no token, no mail', async () => {
            stubGitHub()
            givenExistingUserByEmail()

            const result = await callback('github', null)

            expectError(result, {
                _tag: 'BadRequest',
                message: 'OAuth sign-in requires a session',
            })
            expect(userRepositoryMock.lockById).not.toHaveBeenCalled()
            expect(oauthLinkVerificationRepositoryMock.create).not.toHaveBeenCalled()
            expect(emailServiceMock.send).not.toHaveBeenCalled()
            expectNoSignIn()
        })

        it('refuses with 409 email_changed when the locked account has another address', async () => {
            stubGitHub()
            givenExistingUserByEmail({ email: 'changed@example.com' })

            const result = await callback('github')

            expectError(result, { _tag: 'Conflict', reason: 'email_changed' })
            expect(
                oauthLinkVerificationRepositoryMock.invalidatePendingByUserIdAndProvider,
            ).not.toHaveBeenCalled()
            expect(oauthLinkVerificationRepositoryMock.create).not.toHaveBeenCalled()
            expect(emailServiceMock.send).not.toHaveBeenCalled()
            expectNoSignIn()
        })

        it('answers the mail failure', async () => {
            stubGitHub()
            givenExistingUserByEmail()
            emailServiceMock.send.mockResolvedValue(
                Result.err({ _tag: 'Internal', publicMessage: 'Failed to send email' }),
            )

            const result = await callback('github')

            expectError(result, { _tag: 'Internal' })
            expectNoSignIn()
        })

        it.each([
            [
                'unverified',
                { email: 'user@example.com', email_verified: false },
                'user@example.com',
            ],
            [
                'verified for another address',
                { email: 'other@example.com', email_verified: true },
                'other@example.com',
            ],
            ['missing (no openid scope)', {}, 'user@example.com'],
        ])(
            'GitLab: the OIDC address is %s, the address looked up is the right one',
            async (_label, userinfo, looked) => {
                gitlabValidateAuthorizationCodeMock.mockResolvedValue(tokens('gl-token'))
                stubFetch({
                    'https://gitlab.com/api/v4/user': {
                        id: 9,
                        email: 'user@example.com',
                        name: 'Jane',
                    },
                    'https://gitlab.com/oauth/userinfo': userinfo,
                })
                givenExistingUserByEmail({ email: looked })

                const result = await callback('gitlab')

                expect(userRepositoryMock.findByEmail).toHaveBeenCalledWith(looked)
                expect(Result.isOk(result) && result.value).toEqual({
                    redirectUrl: 'https://app.example.com/?oauth=link_pending',
                })
                expectNoSignIn()
            },
        )
    })

    // --- nobody has the address ----------------------------------------------------------------
    describe('a new account', () => {
        it('Google authoritative: created with the address, verified', async () => {
            stubGoogle({ email: 'Jane@Gmail.com', picture: 'https://cdn.example.com/g.png' })
            givenNewUser()

            const result = await callback('google')

            expect(Result.isOk(result) && result.value).toEqual({
                redirectUrl: 'https://app.example.com/oauth/success',
            })
            expect(userRepositoryMock.create).toHaveBeenCalledWith(
                {
                    name: 'Jane',
                    email: 'jane@gmail.com',
                    password: null,
                    avatar: 'https://cdn.example.com/g.png',
                    emailVerifiedAt: expect.any(Date),
                },
                TX,
            )
            // feat-098: the user and its first link are one transaction.
            expect(oauthAccountRepositoryMock.create).toHaveBeenCalledWith(
                {
                    userId: 8n,
                    provider: 'google',
                    providerUserId: 'g-1',
                    providerEmail: 'jane@gmail.com',
                    providerName: 'Jane',
                    providerAvatar: 'https://cdn.example.com/g.png',
                },
                TX,
            )
            expect(authMock.login).toHaveBeenCalledWith('8', 'new-session-token')
            expect(securityMock).toHaveBeenCalledWith(8n, 'new_sign_in')
            expect(sendLinkVerificationEmailMock).not.toHaveBeenCalled()
        })

        it('any other provider: created without an address, signed in, the address mailed', async () => {
            stubGitHub()
            givenNewUser()

            const result = await callback('github')

            expect(Result.isOk(result) && result.value).toEqual({
                redirectUrl: 'https://app.example.com/oauth/success',
            })
            // Exactly these fields: no address and no verification.
            expect(userRepositoryMock.create).toHaveBeenCalledWith(
                {
                    name: 'Jane',
                    email: null,
                    password: null,
                    avatar: 'https://cdn.example.com/avatar.png',
                },
                TX,
            )
            // The address stays with the OAuth account until its owner confirms it.
            expect(oauthAccountRepositoryMock.create).toHaveBeenCalledWith(
                {
                    userId: 8n,
                    provider: 'github',
                    providerUserId: 'provider-user-1',
                    providerEmail: 'user@example.com',
                    providerName: 'Jane',
                    providerAvatar: 'https://cdn.example.com/avatar.png',
                },
                TX,
            )
            expect(authMock.login).toHaveBeenCalledWith('8', 'new-session-token')
            expect(sendLinkVerificationEmailMock).toHaveBeenCalledWith(
                8n,
                'user@example.com',
                'new-session-token',
            )
            expect(order(authMock.login)).toBeLessThan(order(sendLinkVerificationEmailMock))
            expect(enforceEmailLinkThrottlesMock).toHaveBeenCalledWith(
                'user@example.com',
                8n,
                THROTTLED,
            )
            expect(order(enforceEmailLinkThrottlesMock)).toBeLessThan(
                order(sendLinkVerificationEmailMock),
            )
        })

        // feat-098: a concurrent callback for the same identity committed its user and link
        // first; this transaction rolled back, and the decision is made once more.
        it('a lost race for the link signs in through the winner link, nothing mailed', async () => {
            stubGitHub()
            givenNewUser()
            oauthAccountRepositoryMock.create.mockRejectedValueOnce(
                Object.assign(new Error('duplicate key'), { code: '23505' }),
            )
            oauthAccountRepositoryMock.findByProviderAndProviderId
                .mockResolvedValueOnce(undefined)
                .mockResolvedValueOnce({ id: 21n, userId: 7n })
            userRepositoryMock.lockById.mockResolvedValue({ id: 7n, sessionToken: 'winner-token' })
            oauthAccountRepositoryMock.findLinkForUser.mockResolvedValue({ id: 21n, userId: 7n })

            const result = await callback('github')

            expect(Result.isOk(result) && result.value).toEqual({
                redirectUrl: 'https://app.example.com/oauth/success',
            })
            expect(userRepositoryMock.create).toHaveBeenCalledTimes(1)
            expect(authMock.login).toHaveBeenCalledExactlyOnceWith('7', 'winner-token')
            expect(sendLinkVerificationEmailMock).not.toHaveBeenCalled()
        })

        it('decides again only once: a second unique violation is thrown', async () => {
            stubGitHub()
            givenNewUser()
            const duplicate = Object.assign(new Error('duplicate key'), { code: '23505' })
            oauthAccountRepositoryMock.create.mockRejectedValue(duplicate)

            await expect(callback('github')).rejects.toBe(duplicate)
            expect(userRepositoryMock.create).toHaveBeenCalledTimes(2)
            expectNoSignIn()
        })

        it('any other database error is thrown without a retry', async () => {
            stubGitHub()
            givenNewUser()
            const failure = new Error('connection lost')
            oauthAccountRepositoryMock.create.mockRejectedValue(failure)

            await expect(callback('github')).rejects.toBe(failure)
            expect(userRepositoryMock.create).toHaveBeenCalledTimes(1)
            expectNoSignIn()
        })

        it('a spent mail budget skips the first mail; the sign-in stands', async () => {
            stubGitHub()
            givenNewUser()
            spendMailBudget()

            const result = await callback('github')

            expect(Result.isOk(result) && result.value).toEqual({
                redirectUrl: 'https://app.example.com/oauth/success',
            })
            expect(authMock.login).toHaveBeenCalledWith('8', 'new-session-token')
            expect(sendLinkVerificationEmailMock).not.toHaveBeenCalled()
        })

        it('Google with a third-party address is not trusted for a new account either', async () => {
            stubGoogle({ email: 'user@example.com' })
            givenNewUser()

            await callback('google')

            expect(userRepositoryMock.create).toHaveBeenCalledWith(
                expect.objectContaining({ email: null }),
                TX,
            )
            expect(userRepositoryMock.create).toHaveBeenCalledWith(
                expect.not.objectContaining({ emailVerifiedAt: expect.anything() }),
                TX,
            )
            expect(sendLinkVerificationEmailMock).toHaveBeenCalledWith(
                8n,
                'user@example.com',
                'new-session-token',
            )
        })

        it.each([
            [
                'answers an error',
                () =>
                    sendLinkVerificationEmailMock.mockResolvedValue(
                        Result.err({ _tag: 'BadRequest', message: 'x' }),
                    ),
            ],
            [
                'throws',
                () => sendLinkVerificationEmailMock.mockRejectedValue(new Error('smtp down')),
            ],
        ])('the sign-in stands when the first mail %s, it is only logged', async (_n, arrange) => {
            stubGitHub()
            givenNewUser()
            arrange()

            const result = await callback('github')

            expect(Result.isOk(result)).toBe(true)
            expect(authMock.login).toHaveBeenCalledWith('8', 'new-session-token')
            expect(loggerMock.warn).toHaveBeenCalledWith(
                expect.objectContaining({ userId: '8' }),
                'first email link not sent',
            )
        })

        it('does not mail the address when the sign-in failed', async () => {
            stubGitHub()
            givenNewUser()
            authMock.login.mockResolvedValue(false)

            const result = await callback('github')

            expectError(result, { _tag: 'BadRequest', message: 'Failed to sign in' })
            expect(sendLinkVerificationEmailMock).not.toHaveBeenCalled()
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

        expectError(result, {
            _tag: 'BadRequest',
            message: 'Could not retrieve email from provider',
        })
        expect(authMock.login).not.toHaveBeenCalled()
    })

    it('refuses a state mismatch before talking to the provider', async () => {
        const { oauthService } = await loadOauthService()
        const result = await oauthService.handleCallback(
            'github',
            'oauth-code',
            'stored-state',
            'other-state',
            null,
            authMock as never,
            SESSION_ID,
        )

        expectError(result, { _tag: 'BadRequest', message: 'OAuth state mismatch' })
        expect(githubValidateAuthorizationCodeMock).not.toHaveBeenCalled()
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
                        email: 'user@gmail.com',
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
                givenNewUser()

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

        it('neither token reaches a mailed link', async () => {
            githubValidateAuthorizationCodeMock.mockResolvedValue(
                withRefresh('secret-access-token'),
            )
            stubGitHubUserInfoFetch()
            givenExistingUserByEmail()

            await callback('github')

            const stored = serialize(oauthLinkVerificationRepositoryMock.create.mock.calls)
            expect(stored).not.toContain('secret-access-token')
            expect(stored).not.toContain('secret-refresh-token')
        })

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
            givenExistingLink()

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
            givenExistingLink()

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
            if (returning) givenExistingLink()
            else givenNewUser()

            await callback('github')

            const logged = everythingLogged()
            expect(logged).not.toContain('user@example.com')
            expect(logged).not.toContain('Jane')
            expect(logged).not.toContain('gh-secret-token')
            // Still useful: the address is there, masked.
            expect(logged).toContain('u***r@e*****e.com')
        })

        it('does not log the raw email when a link is mailed', async () => {
            stubGoogle({ email: 'user@example.com', verified_email: false })
            givenExistingUserByEmail()

            await callback('google')

            expect(everythingLogged()).not.toContain('user@example.com')
            expect(everythingLogged()).not.toContain('Jane')
        })
    })
})

// feat-097: the mailed link that confirms an OAuth link, opened in the browser that started it.
describe('oauthService.confirmLink', () => {
    const RAW = 'raw-link-token'

    const linkRow = (over: Record<string, unknown> = {}) => ({
        id: 40n,
        userId: 5n,
        provider: 'github',
        providerUserId: 'gh-1',
        providerEmail: 'user@example.com',
        providerName: 'Jane',
        providerAvatar: null,
        targetEmail: 'user@example.com',
        sessionBindingHash: sha256(SESSION_ID),
        tokenHash: sha256(RAW),
        expiresAt: new Date(Date.now() + 600_000),
        usedAt: null,
        createdAt: new Date(),
        ...over,
    })

    function arrange(over: Record<string, unknown> = {}): void {
        oauthLinkVerificationRepositoryMock.findByTokenHash.mockResolvedValue(linkRow())
        userRepositoryMock.lockById.mockResolvedValue(account(over))
        oauthLinkVerificationRepositoryMock.markUsed.mockResolvedValue(linkRow())
        oauthAccountRepositoryMock.create.mockResolvedValue({ id: 31n, userId: 5n })
        authMock.login.mockResolvedValue(true)
    }

    const confirm = async (token = RAW, sessionId: string | null = SESSION_ID) => {
        const { oauthService } = await loadOauthService()
        return oauthService.confirmLink(token, authMock as never, sessionId)
    }

    const expectNotConsumed = (): void => {
        expect(userRepositoryMock.lockById).not.toHaveBeenCalled()
        expect(oauthLinkVerificationRepositoryMock.markUsed).not.toHaveBeenCalled()
        expect(oauthLinkVerificationRepositoryMock.burn).not.toHaveBeenCalled()
        expect(oauthAccountRepositoryMock.create).not.toHaveBeenCalled()
    }

    it('links a verified account and signs in with its token, no claim cleanup', async () => {
        arrange()

        const result = await confirm(` ${RAW} `)

        expect(Result.isOk(result) && result.value).toEqual({ status: 'success' })
        expect(oauthLinkVerificationRepositoryMock.findByTokenHash).toHaveBeenCalledWith(
            sha256(RAW),
        )
        expect(userRepositoryMock.lockById).toHaveBeenCalledWith(5n, TX)
        expect(oauthLinkVerificationRepositoryMock.markUsed).toHaveBeenCalledWith(40n, TX)
        expect(claimLockedMock).toHaveBeenCalledWith(TX, expect.objectContaining({ id: 5n }))
        expect(oauthAccountRepositoryMock.create).toHaveBeenCalledWith(
            {
                userId: 5n,
                provider: 'github',
                providerUserId: 'gh-1',
                providerEmail: 'user@example.com',
                providerName: 'Jane',
                providerAvatar: null,
            },
            TX,
        )
        expect(order(oauthLinkVerificationRepositoryMock.markUsed)).toBeLessThan(
            order(claimLockedMock),
        )
        expect(order(claimLockedMock)).toBeLessThan(order(oauthAccountRepositoryMock.create))
        expect(destroySessionsQuietlyMock).not.toHaveBeenCalled()
        expect(authMock.login).toHaveBeenCalledWith('5', 'existing-token')
        expect(securityMock).toHaveBeenCalledWith(5n, 'new_sign_in')
    })

    it('claims an unverified account: old sessions go, the new token signs in', async () => {
        arrange({ emailVerifiedAt: null })
        claimAnswers(true)

        const result = await confirm()

        expect(Result.isOk(result)).toBe(true)
        expect(claimLockedMock).toHaveBeenCalledWith(
            TX,
            expect.objectContaining({ id: 5n, emailVerifiedAt: null }),
        )
        expect(oauthAccountRepositoryMock.create).toHaveBeenCalledWith(
            expect.objectContaining({ userId: 5n, provider: 'github' }),
            TX,
        )
        expect(destroySessionsQuietlyMock).toHaveBeenCalledWith('existing-token', 5n)
        expect(authMock.login).toHaveBeenCalledWith('5', 'rotated-token')
        expect(order(destroySessionsQuietlyMock)).toBeLessThan(order(authMock.login))
        expect(securityMock).toHaveBeenCalledTimes(1)
        expect(securityMock).toHaveBeenCalledWith(5n, 'account_claimed')
    })

    it.each([
        ['another browser session', 'other-session'],
        ['no session', null],
    ])('%s: 403 oauth_link_wrong_session, the link stays usable', async (_n, sessionId) => {
        arrange()

        const result = await confirm(RAW, sessionId)

        expectError(result, {
            _tag: 'Forbidden',
            message: 'Open this link in the browser where you started signing in',
            reason: 'oauth_link_wrong_session',
        })
        expectNotConsumed()
        expectNoSignIn()
    })

    it('an unknown token: 400 invalid_token', async () => {
        oauthLinkVerificationRepositoryMock.findByTokenHash.mockResolvedValue(undefined)

        const result = await confirm()

        expectError(result, {
            _tag: 'BadRequest',
            message: 'This link is invalid',
            reason: 'invalid_token',
        })
        expectNotConsumed()
    })

    it('a used token: 400 used_token', async () => {
        arrange()
        oauthLinkVerificationRepositoryMock.findByTokenHash.mockResolvedValue(
            linkRow({ usedAt: new Date() }),
        )

        const result = await confirm()

        expectError(result, {
            _tag: 'BadRequest',
            message: 'This link has already been used',
            reason: 'used_token',
        })
        expectNotConsumed()
        expectNoSignIn()
    })

    it('an expired token: 400 expired_token, burnt', async () => {
        arrange()
        oauthLinkVerificationRepositoryMock.findByTokenHash.mockResolvedValue(
            linkRow({ expiresAt: new Date(Date.now() - 1000) }),
        )

        const result = await confirm()

        expectError(result, {
            _tag: 'BadRequest',
            message: 'This link has expired',
            reason: 'expired_token',
        })
        expect(oauthLinkVerificationRepositoryMock.burn).toHaveBeenCalledWith(40n)
        expect(oauthLinkVerificationRepositoryMock.markUsed).not.toHaveBeenCalled()
        expectNoSignIn()
    })

    it('a token consumed by a concurrent request: 400 used_token, nothing linked', async () => {
        arrange()
        oauthLinkVerificationRepositoryMock.markUsed.mockResolvedValue(undefined)

        const result = await confirm()

        expectError(result, { _tag: 'BadRequest', reason: 'used_token' })
        expect(claimLockedMock).not.toHaveBeenCalled()
        expect(oauthAccountRepositoryMock.create).not.toHaveBeenCalled()
        expectNoSignIn()
    })

    it('the account address changed: 409 email_changed, the link is used up', async () => {
        arrange({ email: 'changed@example.com' })

        const result = await confirm()

        expectError(result, {
            _tag: 'Conflict',
            message: 'The account email changed after this sign-in started',
            reason: 'email_changed',
        })
        expect(oauthLinkVerificationRepositoryMock.markUsed).toHaveBeenCalledWith(40n, TX)
        expect(claimLockedMock).not.toHaveBeenCalled()
        expect(oauthAccountRepositoryMock.create).not.toHaveBeenCalled()
        expectNoSignIn()
    })

    it('the identity is linked to an account already: 409 oauth_already_linked', async () => {
        arrange({ emailVerifiedAt: null })
        claimAnswers(true)
        oauthAccountRepositoryMock.create.mockRejectedValue(
            Object.assign(new Error('duplicate key'), { code: '23505' }),
        )

        const result = await confirm()

        expectError(result, {
            _tag: 'Conflict',
            message: 'This sign-in method is already linked to an account',
            reason: 'oauth_already_linked',
        })
        // Rolled back with the transaction: no claim to clean up after.
        expect(destroySessionsQuietlyMock).not.toHaveBeenCalled()
        expectNoSignIn()
    })

    it('any other failure inside the transaction propagates', async () => {
        arrange()
        oauthAccountRepositoryMock.create.mockRejectedValue(new Error('db down'))

        await expect(confirm()).rejects.toThrow('db down')
        expectNoSignIn()
    })

    it('the account is gone: 404', async () => {
        arrange()
        userRepositoryMock.lockById.mockResolvedValue(undefined)

        const result = await confirm()

        expectError(result, { _tag: 'NotFound' })
        expect(oauthLinkVerificationRepositoryMock.markUsed).not.toHaveBeenCalled()
        expectNoSignIn()
    })

    it('the session cannot be created: 400, no notice', async () => {
        arrange()
        authMock.login.mockResolvedValue(false)

        const result = await confirm()

        expectError(result, { _tag: 'BadRequest', message: 'Failed to sign in' })
        expect(securityMock).not.toHaveBeenCalled()
    })
})

// feat-097: the link that confirms the first address of an account without one, sent again.
describe('oauthService.resendFirstEmailLink', () => {
    const resend = async (presented: string | undefined) => {
        const { oauthService } = await loadOauthService()
        return oauthService.resendFirstEmailLink(7n, presented)
    }

    it.each([
        ['no OAuth account', []],
        ['accounts without a provider address', [{ providerEmail: null }, { providerEmail: '' }]],
    ])('%s: 400 no_pending_email, nothing sent', async (_n, accounts) => {
        oauthAccountRepositoryMock.findByUserId.mockResolvedValue(accounts)

        const result = await resend('presented-token')

        expectError(result, {
            _tag: 'BadRequest',
            message: 'There is no address to confirm',
            reason: 'no_pending_email',
        })
        expect(userRepositoryMock.emailExistsForOtherUser).not.toHaveBeenCalled()
        expect(sendLinkVerificationEmailMock).not.toHaveBeenCalled()
    })

    it('the address belongs to another account: 409, nothing sent', async () => {
        oauthAccountRepositoryMock.findByUserId.mockResolvedValue([
            { providerEmail: ' User@Example.com ' },
        ])
        userRepositoryMock.emailExistsForOtherUser.mockResolvedValue(true)

        const result = await resend('presented-token')

        expectError(result, {
            _tag: 'Conflict',
            message: 'Email is already linked to another account',
        })
        expect(userRepositoryMock.emailExistsForOtherUser).toHaveBeenCalledWith(
            'user@example.com',
            7n,
        )
        expect(sendLinkVerificationEmailMock).not.toHaveBeenCalled()
    })

    it('sends the first provider address with the presented session token', async () => {
        oauthAccountRepositoryMock.findByUserId.mockResolvedValue([
            { providerEmail: null },
            { providerEmail: 'User@Example.com' },
            { providerEmail: 'second@example.com' },
        ])
        userRepositoryMock.emailExistsForOtherUser.mockResolvedValue(false)
        sendLinkVerificationEmailMock.mockResolvedValue(
            Result.ok({ message: 'Verification email sent' }),
        )

        const result = await resend('presented-token')

        expect(Result.isOk(result) && result.value).toEqual({ message: 'Verification email sent' })
        expect(sendLinkVerificationEmailMock).toHaveBeenCalledWith(
            7n,
            'user@example.com',
            'presented-token',
        )
        expect(enforceEmailLinkThrottlesMock).toHaveBeenCalledWith(
            'user@example.com',
            7n,
            THROTTLED,
        )
    })

    it('a spent mail budget: 400 too_many_attempts before any lookup or mail', async () => {
        oauthAccountRepositoryMock.findByUserId.mockResolvedValue([
            { providerEmail: 'user@example.com' },
        ])
        spendMailBudget()

        const result = await resend('presented-token')

        expectError(result, THROTTLED)
        expect(userRepositoryMock.emailExistsForOtherUser).not.toHaveBeenCalled()
        expect(sendLinkVerificationEmailMock).not.toHaveBeenCalled()
    })

    it('answers what the link sender answers (a revoked session included)', async () => {
        oauthAccountRepositoryMock.findByUserId.mockResolvedValue([
            { providerEmail: 'user@example.com' },
        ])
        userRepositoryMock.emailExistsForOtherUser.mockResolvedValue(false)
        sendLinkVerificationEmailMock.mockResolvedValue(
            Result.err({
                _tag: 'Unauthorized',
                message: 'Session has been revoked',
                reason: 'session_revoked',
            }),
        )

        const result = await resend(undefined)

        expectError(result, { _tag: 'Unauthorized', reason: 'session_revoked' })
        expect(sendLinkVerificationEmailMock).toHaveBeenCalledWith(
            7n,
            'user@example.com',
            undefined,
        )
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
