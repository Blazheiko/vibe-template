import { Result } from 'better-result'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionAuthState } from 'shared/mfa'
import { testUserActor } from '../../../test-support/audit-actor.js'

// feat-199 (security review 2026-11-12, M-2): listing and removing the identities of OAuth
// providers linked to an account. The row lock and the "not the last one" rule under two
// removals at once are proved against PostgreSQL (sign-in-methods.pg.test.ts).
const TX = { transaction: true }
const mocks = vi.hoisted(() => ({
    userRepository: { findById: vi.fn(), lockById: vi.fn() },
    oauthAccountRepository: { findByUserId: vi.fn(), deleteByIdForUser: vi.fn() },
    totpFactorRepository: { findByUserId: vi.fn() },
    recoveryCodeRepository: { countUnused: vi.fn() },
    security: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

// feat-235: the audit write of each write point is covered by its *.pg.test.ts.
vi.mock('#app/services/audit/audit-service.js', () => ({
    auditService: {
        stamp: vi.fn(() => Promise.resolve({ occurredAt: '2026-11-20 00:00:00' })),
        record: vi.fn(() => Promise.resolve([])),
        logCommitted: vi.fn(),
    },
}))
vi.mock('#app/repositories/index.js', () => ({
    userRepository: mocks.userRepository,
    oauthAccountRepository: mocks.oauthAccountRepository,
    totpFactorRepository: mocks.totpFactorRepository,
    recoveryCodeRepository: mocks.recoveryCodeRepository,
    withTransaction: (fn: (tx: unknown) => unknown) => fn(TX),
}))
vi.mock('#app/services/notifications/user-notification-service.js', () => ({
    userNotificationService: { security: mocks.security },
}))
vi.mock('#vendor/utils/logger.js', () => ({ default: mocks.logger }))

const { signInMethodsService } = await import('./sign-in-methods-service.js')

const NOW = Date.parse('2026-11-13T12:00:00Z')
const TOKEN = 'session-token'
// feat-245 (row 8 of Р3): a password proven within 300 s, an OAuth sign-in within 600 s.
const REAUTH_WINDOW_MS = 300_000
const OAUTH_RECENT_MS = 600_000

/** The auth state of the request's session: the marks it carries (ISO). */
const authWith = (verified: Record<string, string>): SessionAuthState => ({
    v: 1,
    amr: ['pwd'],
    aal: 1,
    authenticatedAt: new Date(NOW - 3_600_000).toISOString(),
    verified,
})
const freshPassword = authWith({ pwd: new Date(NOW - 60_000).toISOString() })
const recentOAuth = authWith({ oauth: new Date(NOW - 60_000).toISOString() })

const user = (over: Record<string, unknown> = {}) => ({
    id: 5n,
    password: 'stored-hash',
    sessionToken: TOKEN,
    ...over,
})

const link = (id: bigint, over: Record<string, unknown> = {}) => ({
    id,
    userId: 5n,
    provider: 'github',
    providerUserId: `gh-${String(id)}`,
    providerEmail: 'owner@example.com',
    providerName: 'Jane',
    providerAvatar: null,
    createdAt: new Date('2026-11-01T10:00:00Z'),
    updatedAt: new Date('2026-11-01T10:00:00Z'),
    ...over,
})

const request = (over: Record<string, unknown> = {}) => ({
    linkId: 31n,
    presentedSessionToken: TOKEN as string | undefined,
    sessionAuth: freshPassword as SessionAuthState | undefined,
    sessionStored: vi.fn(() => Promise.resolve(true)),
    actor: testUserActor(),
    now: NOW,
    ...over,
})

/** The account as every read of it answers, and its links. */
const given = (account: ReturnType<typeof user>, links: ReturnType<typeof link>[]): void => {
    mocks.userRepository.findById.mockResolvedValue(account)
    mocks.userRepository.lockById.mockResolvedValue(account)
    mocks.oauthAccountRepository.findByUserId.mockResolvedValue(links)
}

const expectError = (result: unknown, expected: Record<string, unknown>): void => {
    expect(Result.isError(result as never)).toBe(true)
    expect((result as { error: unknown }).error).toMatchObject(expected)
}

const expectNothingRemoved = (): void => {
    expect(mocks.oauthAccountRepository.deleteByIdForUser).not.toHaveBeenCalled()
    expect(mocks.security).not.toHaveBeenCalled()
}

beforeEach(() => {
    vi.clearAllMocks()
    mocks.totpFactorRepository.findByUserId.mockResolvedValue(undefined)
    mocks.recoveryCodeRepository.countUnused.mockResolvedValue(0)
    mocks.oauthAccountRepository.deleteByIdForUser.mockResolvedValue(true)
})

describe('signInMethodsService.list', () => {
    it('lists the links of the account, oldest first, without provider ids or addresses', async () => {
        given(user(), [
            link(32n, { provider: 'google', createdAt: new Date('2026-11-05T10:00:00Z') }),
            link(31n),
        ])

        const result = await signInMethodsService.list(5n)

        expect(mocks.oauthAccountRepository.findByUserId).toHaveBeenCalledWith(5n)
        expect(Result.isOk(result) && result.value).toEqual({
            hasPassword: true,
            methods: [
                {
                    id: '31',
                    provider: 'github',
                    name: 'Jane',
                    linkedAt: '2026-11-01T10:00:00.000Z',
                },
                {
                    id: '32',
                    provider: 'google',
                    name: 'Jane',
                    linkedAt: '2026-11-05T10:00:00.000Z',
                },
            ],
        })
    })

    it.each([null, ''])('says an account with password %j has none', async (password) => {
        given(user({ password }), [link(31n)])

        const result = await signInMethodsService.list(5n)

        expect(Result.isOk(result) && result.value.hasPassword).toBe(false)
    })

    it('does not show a profile name that carries a link, or none at all', async () => {
        given(user(), [
            link(31n, { providerName: 'Sign in at https://evil.example/x' }),
            link(32n, { providerName: null }),
        ])

        const result = await signInMethodsService.list(5n)

        expect(Result.isOk(result) && result.value.methods.map((m) => m.name)).toEqual([null, null])
    })

    it('answers not found for a user that no longer exists', async () => {
        mocks.userRepository.findById.mockResolvedValue(undefined)

        expectError(await signInMethodsService.list(5n), { _tag: 'NotFound' })
    })
})

describe('signInMethodsService.unlink: an account with a password', () => {
    it('removes the link after a fresh password, under the row lock, and tells the owner', async () => {
        given(user(), [link(31n), link(32n, { provider: 'google' })])

        const result = await signInMethodsService.unlink(5n, request())

        expect(Result.isOk(result) && result.value).toEqual({ provider: 'github' })
        expect(mocks.userRepository.lockById).toHaveBeenCalledWith(5n, TX)
        expect(mocks.oauthAccountRepository.findByUserId).toHaveBeenCalledWith(5n, TX)
        expect(mocks.oauthAccountRepository.deleteByIdForUser).toHaveBeenCalledWith(31n, 5n, TX)
        expect(mocks.security).toHaveBeenCalledWith(5n, 'sign_in_method_removed', {
            provider: 'github',
        })
    })

    it('removes the only link: the password still signs in', async () => {
        given(user(), [link(31n)])

        const result = await signInMethodsService.unlink(5n, request())

        expect(Result.isOk(result)).toBe(true)
        expect(mocks.oauthAccountRepository.deleteByIdForUser).toHaveBeenCalledTimes(1)
    })

    it('accepts a password proven exactly as long ago as the window', async () => {
        given(user(), [link(31n)])

        const result = await signInMethodsService.unlink(
            5n,
            request({
                sessionAuth: authWith({ pwd: new Date(NOW - REAUTH_WINDOW_MS).toISOString() }),
            }),
        )

        expect(Result.isOk(result)).toBe(true)
    })

    it.each([
        ['no auth state (a session from before feat-245)', undefined],
        ['no mark at all', authWith({})],
        [
            'a stale password mark',
            authWith({ pwd: new Date(NOW - REAUTH_WINDOW_MS - 1).toISOString() }),
        ],
        ['only a recent OAuth sign-in', recentOAuth],
    ])('asks for the password again with %s', async (_, sessionAuth) => {
        given(user(), [link(31n)])

        const result = await signInMethodsService.unlink(5n, request({ sessionAuth }))

        expectError(result, {
            _tag: 'Forbidden',
            reason: 'reauth_required',
            details: { kind: 'reauth_required', proofs: ['password'] },
        })
        expect(mocks.userRepository.lockById).not.toHaveBeenCalled()
        expectNothingRemoved()
    })

    it('with MFA on, a fresh password is not enough: the second factor is asked', async () => {
        given(user(), [link(31n)])
        mocks.totpFactorRepository.findByUserId.mockResolvedValue({ userId: 5n })

        const result = await signInMethodsService.unlink(5n, request())

        expectError(result, {
            _tag: 'Forbidden',
            reason: 'reauth_required',
            details: { kind: 'reauth_required', proofs: ['totp'] },
        })
        expectNothingRemoved()
    })

    it('with MFA on, a fresh TOTP mark removes the link', async () => {
        given(user(), [link(31n)])
        mocks.totpFactorRepository.findByUserId.mockResolvedValue({ userId: 5n })

        const result = await signInMethodsService.unlink(
            5n,
            request({ sessionAuth: authWith({ otp: new Date(NOW - 60_000).toISOString() }) }),
        )

        expect(Result.isOk(result)).toBe(true)
    })
})

describe('signInMethodsService.unlink: an account without a password', () => {
    const noPassword = user({ password: null })

    it('removes one of several links after a recent OAuth sign-in, with no password asked', async () => {
        given(noPassword, [link(31n), link(32n, { provider: 'google' })])

        const result = await signInMethodsService.unlink(5n, request({ sessionAuth: recentOAuth }))

        expect(Result.isOk(result)).toBe(true)
        expect(mocks.oauthAccountRepository.deleteByIdForUser).toHaveBeenCalledWith(31n, 5n, TX)
    })

    it('accepts an OAuth sign-in exactly as old as the limit', async () => {
        given(noPassword, [link(31n), link(32n)])

        const result = await signInMethodsService.unlink(
            5n,
            request({
                sessionAuth: authWith({ oauth: new Date(NOW - OAUTH_RECENT_MS).toISOString() }),
            }),
        )

        expect(Result.isOk(result)).toBe(true)
    })

    it.each([
        [
            'older than the limit',
            authWith({ oauth: new Date(NOW - OAUTH_RECENT_MS - 1).toISOString() }),
        ],
        ['from the future', authWith({ oauth: new Date(NOW + 120_000).toISOString() })],
        ['unreadable', authWith({ oauth: 'not a date' })],
        ['missing', authWith({})],
        ['missing with no auth state', undefined],
    ])('refuses a session whose OAuth sign-in is %s', async (_, sessionAuth) => {
        given(noPassword, [link(31n), link(32n)])

        const result = await signInMethodsService.unlink(5n, request({ sessionAuth }))

        expectError(result, { _tag: 'Forbidden', reason: 'sign_in_again_required' })
        expect(mocks.userRepository.lockById).not.toHaveBeenCalled()
        expectNothingRemoved()
    })

    it('never removes the last way in', async () => {
        given(noPassword, [link(31n)])

        const result = await signInMethodsService.unlink(5n, request({ sessionAuth: recentOAuth }))

        expectError(result, { _tag: 'Conflict', reason: 'last_sign_in_method' })
        expectNothingRemoved()
    })

    it('decides "the last one" on the row read under the lock', async () => {
        // The password was there when the request was let in and was removed meanwhile (a claim).
        mocks.userRepository.findById.mockResolvedValue(user())
        mocks.userRepository.lockById.mockResolvedValue(noPassword)
        mocks.oauthAccountRepository.findByUserId.mockResolvedValue([link(31n)])

        const result = await signInMethodsService.unlink(5n, request())

        expectError(result, { _tag: 'Conflict', reason: 'last_sign_in_method' })
        expectNothingRemoved()
    })
})

describe('signInMethodsService.unlink: what it refuses for every account', () => {
    it("answers not found for another account's link, and removes nothing", async () => {
        // The links of the caller; id 99 belongs to somebody else.
        given(user(), [link(31n)])

        const result = await signInMethodsService.unlink(5n, request({ linkId: 99n }))

        expectError(result, { _tag: 'NotFound', message: 'Sign-in method not found' })
        expectNothingRemoved()
    })

    it('answers not found when the link went away between the read and the delete', async () => {
        given(user(), [link(31n)])
        mocks.oauthAccountRepository.deleteByIdForUser.mockResolvedValue(false)

        const result = await signInMethodsService.unlink(5n, request())

        expectError(result, { _tag: 'NotFound' })
        expect(mocks.security).not.toHaveBeenCalled()
    })

    it.each([
        ['no token was presented', undefined],
        ['the token was rotated', 'older-token'],
    ])('refuses a revoked session: %s', async (_, presentedSessionToken) => {
        given(user(), [link(31n)])

        const result = await signInMethodsService.unlink(5n, request({ presentedSessionToken }))

        expectError(result, { _tag: 'Unauthorized', reason: 'session_revoked' })
        expect(mocks.totpFactorRepository.findByUserId).not.toHaveBeenCalled()
        expectNothingRemoved()
    })

    it('refuses when the session record is gone (a logout in another tab)', async () => {
        given(user(), [link(31n)])

        const result = await signInMethodsService.unlink(
            5n,
            request({ sessionStored: vi.fn(() => Promise.resolve(false)) }),
        )

        expectError(result, { _tag: 'Unauthorized', reason: 'session_revoked' })
        expect(mocks.userRepository.lockById).not.toHaveBeenCalled()
        expectNothingRemoved()
    })

    it('refuses when the token was rotated while the proof was checked', async () => {
        mocks.userRepository.findById.mockResolvedValue(user())
        mocks.userRepository.lockById.mockResolvedValue(user({ sessionToken: 'rotated' }))
        mocks.oauthAccountRepository.findByUserId.mockResolvedValue([link(31n)])

        const result = await signInMethodsService.unlink(5n, request())

        expectError(result, { _tag: 'Unauthorized', reason: 'session_revoked' })
        expectNothingRemoved()
    })

    it('answers not found for a user that no longer exists', async () => {
        mocks.userRepository.findById.mockResolvedValue(undefined)

        expectError(await signInMethodsService.unlink(5n, request()), { _tag: 'NotFound' })
        expectNothingRemoved()
    })
})
