import { Result } from 'better-result'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// feat-199 (security review 2026-11-12, M-2): listing and removing the identities of OAuth
// providers linked to an account. The row lock and the "not the last one" rule under two
// removals at once are proved against PostgreSQL (sign-in-methods.pg.test.ts).
const TX = { transaction: true }
const mocks = vi.hoisted(() => ({
    userRepository: { findById: vi.fn(), lockById: vi.fn() },
    oauthAccountRepository: { findByUserId: vi.fn(), deleteByIdForUser: vi.fn() },
    validatePassword: vi.fn(),
    consumeAuthThrottle: vi.fn(),
    resetAuthThrottle: vi.fn(),
    security: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('#app/repositories/index.js', () => ({
    userRepository: mocks.userRepository,
    oauthAccountRepository: mocks.oauthAccountRepository,
    withTransaction: (fn: (tx: unknown) => unknown) => fn(TX),
}))
vi.mock('metautil', () => ({ validatePassword: mocks.validatePassword }))
vi.mock('#app/services/auth/auth-throttle-service.js', () => ({
    consumeAuthThrottle: mocks.consumeAuthThrottle,
    resetAuthThrottle: mocks.resetAuthThrottle,
}))
vi.mock('#app/services/notifications/user-notification-service.js', () => ({
    userNotificationService: { security: mocks.security },
}))
vi.mock('#vendor/utils/logger.js', () => ({ default: mocks.logger }))

const { signInMethodsService, RECENT_SIGN_IN_MS } = await import('./sign-in-methods-service.js')

const NOW = Date.parse('2026-11-13T12:00:00Z')
const TOKEN = 'session-token'

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
    currentPassword: 'right-password' as string | undefined,
    presentedSessionToken: TOKEN as string | undefined,
    sessionCreatedAt: new Date(NOW - 60_000).toISOString() as string | undefined,
    sessionStored: vi.fn(() => Promise.resolve(true)),
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
    mocks.validatePassword.mockResolvedValue(true)
    mocks.consumeAuthThrottle.mockResolvedValue({ allowed: true, count: 1 })
    mocks.resetAuthThrottle.mockResolvedValue(undefined)
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
    it('removes the link after the current password, under the row lock, and tells the owner', async () => {
        given(user(), [link(31n), link(32n, { provider: 'google' })])

        const result = await signInMethodsService.unlink(5n, request())

        expect(Result.isOk(result) && result.value).toEqual({ provider: 'github' })
        expect(mocks.validatePassword).toHaveBeenCalledWith('right-password', 'stored-hash')
        expect(mocks.userRepository.lockById).toHaveBeenCalledWith(5n, TX)
        expect(mocks.oauthAccountRepository.findByUserId).toHaveBeenCalledWith(5n, TX)
        expect(mocks.oauthAccountRepository.deleteByIdForUser).toHaveBeenCalledWith(31n, 5n, TX)
        expect(mocks.security).toHaveBeenCalledWith(5n, 'sign_in_method_removed')
    })

    it('removes the only link: the password still signs in', async () => {
        given(user(), [link(31n)])

        const result = await signInMethodsService.unlink(5n, request())

        expect(Result.isOk(result)).toBe(true)
        expect(mocks.oauthAccountRepository.deleteByIdForUser).toHaveBeenCalledTimes(1)
    })

    it.each([undefined, ''])(
        'refuses without the current password (%j)',
        async (currentPassword) => {
            given(user(), [link(31n)])

            const result = await signInMethodsService.unlink(5n, request({ currentPassword }))

            expectError(result, { _tag: 'BadRequest', reason: 'current_password_required' })
            expect(mocks.validatePassword).not.toHaveBeenCalled()
            expect(mocks.consumeAuthThrottle).not.toHaveBeenCalled()
            expectNothingRemoved()
        },
    )

    it('refuses a wrong password, whatever the age of the session', async () => {
        given(user(), [link(31n)])
        mocks.validatePassword.mockResolvedValue(false)

        const result = await signInMethodsService.unlink(5n, request())

        expectError(result, { _tag: 'BadRequest', reason: 'current_password_incorrect' })
        expect(mocks.resetAuthThrottle).not.toHaveBeenCalled()
        expectNothingRemoved()
    })

    it('spends the change-password budget before the check and stops when it is used up', async () => {
        given(user(), [link(31n)])
        mocks.consumeAuthThrottle.mockResolvedValue({ allowed: false, count: 6 })

        const result = await signInMethodsService.unlink(5n, request())

        expectError(result, { _tag: 'RateLimited' })
        expect(mocks.consumeAuthThrottle).toHaveBeenCalledWith(
            expect.objectContaining({ scope: expect.stringContaining('change') }),
            '5',
        )
        expect(mocks.validatePassword).not.toHaveBeenCalled()
        expectNothingRemoved()
    })

    it('a right password resets the budget; a failed reset does not fail the removal', async () => {
        given(user(), [link(31n)])
        mocks.resetAuthThrottle.mockRejectedValue(new Error('redis down'))

        const result = await signInMethodsService.unlink(5n, request())

        expect(Result.isOk(result)).toBe(true)
        expect(mocks.resetAuthThrottle).toHaveBeenCalledTimes(1)
    })
})

describe('signInMethodsService.unlink: an account without a password', () => {
    const noPassword = user({ password: null })

    it('removes one of several links after a recent sign-in, with no password asked', async () => {
        given(noPassword, [link(31n), link(32n, { provider: 'google' })])

        const result = await signInMethodsService.unlink(
            5n,
            request({ currentPassword: undefined }),
        )

        expect(Result.isOk(result)).toBe(true)
        expect(mocks.validatePassword).not.toHaveBeenCalled()
        expect(mocks.consumeAuthThrottle).not.toHaveBeenCalled()
        expect(mocks.oauthAccountRepository.deleteByIdForUser).toHaveBeenCalledWith(31n, 5n, TX)
    })

    it('accepts a sign-in exactly as old as the limit', async () => {
        given(noPassword, [link(31n), link(32n)])

        const result = await signInMethodsService.unlink(
            5n,
            request({ sessionCreatedAt: new Date(NOW - RECENT_SIGN_IN_MS).toISOString() }),
        )

        expect(Result.isOk(result)).toBe(true)
    })

    it.each([
        ['older than the limit', new Date(NOW - RECENT_SIGN_IN_MS - 1).toISOString()],
        ['from the future', new Date(NOW + 60_000).toISOString()],
        ['unreadable', 'not a date'],
        ['missing', undefined],
    ])('refuses a session whose sign-in is %s', async (_, sessionCreatedAt) => {
        given(noPassword, [link(31n), link(32n)])

        const result = await signInMethodsService.unlink(5n, request({ sessionCreatedAt }))

        expectError(result, { _tag: 'Forbidden', reason: 'recent_sign_in_required' })
        expect(mocks.userRepository.lockById).not.toHaveBeenCalled()
        expectNothingRemoved()
    })

    it('never removes the last way in', async () => {
        given(noPassword, [link(31n)])

        const result = await signInMethodsService.unlink(5n, request())

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
        expect(mocks.validatePassword).not.toHaveBeenCalled()
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

    it('refuses when the token was rotated while the password was checked', async () => {
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
