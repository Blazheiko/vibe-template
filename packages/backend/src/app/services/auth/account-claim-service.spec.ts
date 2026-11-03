import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// feat-097: the claim of an account whose address was never verified. Here: what it writes and
// retires, on the transaction the caller hands it. Atomicity and the row lock are proved
// against PostgreSQL (*.pg.test.ts).

const mocks = vi.hoisted(() => {
    const tokenRepository = () => ({ invalidatePendingByUserId: vi.fn() })
    return {
        userRepository: { update: vi.fn() },
        emailVerificationRepository: tokenRepository(),
        emailLinkVerificationRepository: tokenRepository(),
        passwordResetRepository: tokenRepository(),
        oauthLinkVerificationRepository: tokenRepository(),
        oauthAccountRepository: { deleteByUserId: vi.fn() },
        pushSubscriptionRepository: { deleteByUserId: vi.fn() },
        smsAuthChallengeRepository: { invalidatePendingForPhoneFlow: vi.fn() },
        destroyAllSessions: vi.fn(),
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    }
})

vi.mock('#app/repositories/index.js', () => ({
    userRepository: mocks.userRepository,
    emailVerificationRepository: mocks.emailVerificationRepository,
    emailLinkVerificationRepository: mocks.emailLinkVerificationRepository,
    passwordResetRepository: mocks.passwordResetRepository,
    oauthLinkVerificationRepository: mocks.oauthLinkVerificationRepository,
    oauthAccountRepository: mocks.oauthAccountRepository,
    pushSubscriptionRepository: mocks.pushSubscriptionRepository,
    smsAuthChallengeRepository: mocks.smsAuthChallengeRepository,
}))
vi.mock('#vendor/utils/session/redis-session-storage.js', () => ({
    destroyAllSessions: mocks.destroyAllSessions,
}))
vi.mock('nanoid', () => ({ nanoid: () => 'rotated-token' }))
vi.mock('#logger', () => ({ default: mocks.logger }))

const TX = { transaction: true } as never
const PHONE = '+380501234567'

const {
    ALL_TOKEN_REPOSITORIES,
    addressMatches,
    claimLocked,
    destroySessionsQuietly,
    invalidatePendingPhoneChallenges,
} = await import('./account-claim-service.js')

type UserRow = Parameters<typeof claimLocked>[1]

const user = (over: Partial<UserRow> = {}): UserRow =>
    ({
        id: 5n,
        name: 'Jane',
        email: 'jane@example.com',
        emailVerifiedAt: null,
        password: 'attacker-hash',
        phone: PHONE,
        sessionToken: 'old-token',
        ...over,
    }) as UserRow

const TOKEN_REPOSITORIES = [
    mocks.emailVerificationRepository,
    mocks.emailLinkVerificationRepository,
    mocks.passwordResetRepository,
    mocks.oauthLinkVerificationRepository,
]

function expectNothingTakenAway(): void {
    expect(mocks.oauthAccountRepository.deleteByUserId).not.toHaveBeenCalled()
    expect(mocks.pushSubscriptionRepository.deleteByUserId).not.toHaveBeenCalled()
    for (const repository of TOKEN_REPOSITORIES) {
        expect(repository.invalidatePendingByUserId).not.toHaveBeenCalled()
    }
    expect(mocks.smsAuthChallengeRepository.invalidatePendingForPhoneFlow).not.toHaveBeenCalled()
}

beforeEach(() => {
    mocks.userRepository.update.mockImplementation((id: bigint, data: Partial<UserRow>) =>
        Promise.resolve({ ...user(), id, ...data }),
    )
})

afterEach(() => {
    vi.resetAllMocks()
})

describe('addressMatches', () => {
    it.each([
        ['the same address', 'jane@example.com', 'jane@example.com', true],
        ['another case and spaces', ' Jane@Example.COM ', 'jane@example.com', true],
        ['another address', 'jane@example.com', 'john@example.com', false],
        ['no address on the account', null, 'jane@example.com', false],
    ])('%s → %s', (_n, email, proven, expected) => {
        expect(addressMatches(user({ email }), proven)).toBe(expected)
    })
})

describe('claimLocked', () => {
    it('a verified account without a new password: nothing changes', async () => {
        const verified = user({ emailVerifiedAt: new Date() })

        const outcome = await claimLocked(TX, verified)

        expect(outcome).toEqual({
            claimed: false,
            user: verified,
            previousSessionToken: 'old-token',
        })
        expect(mocks.userRepository.update).not.toHaveBeenCalled()
        expectNothingTakenAway()
    })

    it('a verified account with a new password: only the password and the session token', async () => {
        const verified = user({ emailVerifiedAt: new Date() })

        const outcome = await claimLocked(TX, verified, { newPasswordHash: 'new-hash' })

        expect(mocks.userRepository.update).toHaveBeenCalledTimes(1)
        expect(mocks.userRepository.update).toHaveBeenCalledWith(
            5n,
            { password: 'new-hash', sessionToken: 'rotated-token' },
            TX,
        )
        expect(outcome.claimed).toBe(false)
        expect(outcome.previousSessionToken).toBe('old-token')
        expect(outcome.user).toMatchObject({ password: 'new-hash', sessionToken: 'rotated-token' })
        // The phone, the links and the subscriptions belong to the verified owner.
        expectNothingTakenAway()
    })

    it('an unverified account is claimed: everything set up before the proof goes', async () => {
        const outcome = await claimLocked(TX, user())

        expect(mocks.userRepository.update).toHaveBeenCalledTimes(1)
        expect(mocks.userRepository.update).toHaveBeenCalledWith(
            5n,
            {
                emailVerifiedAt: expect.any(Date),
                password: null,
                phone: null,
                sessionToken: 'rotated-token',
            },
            TX,
        )
        expect(mocks.oauthAccountRepository.deleteByUserId).toHaveBeenCalledWith(5n, TX)
        expect(mocks.pushSubscriptionRepository.deleteByUserId).toHaveBeenCalledWith(5n, TX)
        for (const repository of TOKEN_REPOSITORIES) {
            expect(repository.invalidatePendingByUserId).toHaveBeenCalledWith(5n, TX)
        }
        expect(mocks.smsAuthChallengeRepository.invalidatePendingForPhoneFlow).toHaveBeenCalledWith(
            PHONE,
            'reset_phone',
            TX,
        )
        expect(mocks.smsAuthChallengeRepository.invalidatePendingForPhoneFlow).toHaveBeenCalledWith(
            PHONE,
            'link_phone',
            TX,
        )
        expect(outcome.claimed).toBe(true)
        expect(outcome.previousSessionToken).toBe('old-token')
        expect(outcome.user).toMatchObject({
            password: null,
            phone: null,
            sessionToken: 'rotated-token',
        })
        expect(outcome.user.emailVerifiedAt).toBeInstanceOf(Date)
    })

    it('an unverified account claimed by a reset gets the new password', async () => {
        await claimLocked(TX, user(), { newPasswordHash: 'new-hash' })

        expect(mocks.userRepository.update).toHaveBeenCalledWith(
            5n,
            expect.objectContaining({ password: 'new-hash', phone: null }),
            TX,
        )
        expect(mocks.oauthAccountRepository.deleteByUserId).toHaveBeenCalledWith(5n, TX)
    })

    it.each([
        ['no phone', null],
        ['an empty phone', ''],
    ])('with %s there are no phone challenges to retire', async (_n, phone) => {
        await claimLocked(TX, user({ phone }))

        expect(
            mocks.smsAuthChallengeRepository.invalidatePendingForPhoneFlow,
        ).not.toHaveBeenCalled()
        expect(mocks.oauthAccountRepository.deleteByUserId).toHaveBeenCalledWith(5n, TX)
    })

    it.each([
        ['an unverified', null],
        ['a verified', new Date()],
    ])('%s account that disappeared under the update throws (rolls back)', async (_n, at) => {
        mocks.userRepository.update.mockResolvedValue(undefined)

        await expect(
            claimLocked(TX, user({ emailVerifiedAt: at }), { newPasswordHash: 'h' }),
        ).rejects.toThrow('User disappeared during the claim')
        expectNothingTakenAway()
    })

    it('a failing step propagates, so the caller transaction rolls back', async () => {
        mocks.pushSubscriptionRepository.deleteByUserId.mockRejectedValue(new Error('db down'))

        await expect(claimLocked(TX, user())).rejects.toThrow('db down')
    })
})

describe('the token repositories a claim retires', () => {
    it('are all four one-time token tables', () => {
        expect(ALL_TOKEN_REPOSITORIES).toEqual(TOKEN_REPOSITORIES)
    })
})

describe('invalidatePendingPhoneChallenges', () => {
    it('retires the reset and link challenges of the phone in the given transaction', async () => {
        await invalidatePendingPhoneChallenges(PHONE, TX)

        expect(mocks.smsAuthChallengeRepository.invalidatePendingForPhoneFlow.mock.calls).toEqual([
            [PHONE, 'reset_phone', TX],
            [PHONE, 'link_phone', TX],
        ])
    })
})

describe('destroySessionsQuietly', () => {
    it('deletes the sessions of the previous token', async () => {
        await destroySessionsQuietly('old-token', 5n)

        expect(mocks.destroyAllSessions).toHaveBeenCalledWith('old-token')
        expect(mocks.logger.warn).not.toHaveBeenCalled()
    })

    it('only logs a failure: the committed operation stands', async () => {
        const failure = new Error('redis down')
        mocks.destroyAllSessions.mockRejectedValue(failure)

        await expect(destroySessionsQuietly('old-token', 5n)).resolves.toBeUndefined()
        expect(mocks.logger.warn).toHaveBeenCalledWith(
            { err: failure, userId: '5' },
            'Previous sessions not deleted after a password reset',
        )
    })
})
