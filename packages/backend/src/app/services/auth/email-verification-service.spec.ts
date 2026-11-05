import { Result } from 'better-result'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// feat-129: the session-still-stored guard is required; these cases keep the session.
const sessionStillStored = (): Promise<boolean> => Promise.resolve(true)

const userRepositoryMock = {
    findById: vi.fn(),
    findByEmail: vi.fn(),
    update: vi.fn(),
    lockById: vi.fn(),
}

const emailVerificationRepositoryMock = {
    create: vi.fn(),
    findByTokenHash: vi.fn(),
    invalidatePendingByUserId: vi.fn(),
    markUsed: vi.fn(),
    burn: vi.fn(),
}
const emailLinkVerificationRepositoryMock = {
    create: vi.fn(),
    findByTokenHash: vi.fn(),
    invalidatePendingByUserId: vi.fn(),
    markUsed: vi.fn(),
    burn: vi.fn(),
}

const emailServiceMock = {
    send: vi.fn(),
}

const loggerMock = {
    warn: vi.fn(),
    error: vi.fn(),
}

const originalEnv = { ...process.env }

const consumeAuthThrottleMock = vi.fn()
vi.mock('#app/services/auth/auth-throttle-service.js', () => ({
    consumeAuthThrottle: consumeAuthThrottleMock,
}))

// A stand-in for the transaction `withTransaction` hands to the repositories; the real
// commit/rollback behaviour is proved against PostgreSQL (one-time-token-race.pg.test.ts).
const TX = vi.hoisted(() => ({ transaction: true }))
vi.mock('#app/repositories/index.js', () => ({
    userRepository: userRepositoryMock,
    emailVerificationRepository: emailVerificationRepositoryMock,
    emailLinkVerificationRepository: emailLinkVerificationRepositoryMock,
    withTransaction: <T>(work: (tx: unknown) => Promise<T>): Promise<T> => work(TX),
}))

vi.mock('#app/services/notifications/email-service.js', () => ({
    emailService: emailServiceMock,
}))

vi.mock('#logger', () => ({
    default: loggerMock,
}))

const validatePasswordMock = vi.hoisted(() => vi.fn())
vi.mock('metautil', () => ({ validatePassword: validatePasswordMock }))

// feat-097: who opens the link. The registration link's owner signed in to that account; the
// email link's requester is the session of the account that asked for it.
const OWN_SESSION_7 = { userId: 7n, presentedSessionToken: 'session-7' }
const OWN_SESSION_8 = { userId: 8n, presentedSessionToken: 'session-8' }
const ANONYMOUS = { userId: null, presentedSessionToken: undefined }
type Requester = Parameters<
    Awaited<
        ReturnType<typeof loadEmailVerificationService>
    >['emailVerificationService']['verifyEmail']
>[2]

function restoreEnv(): void {
    for (const key of Object.keys(process.env)) {
        if (!(key in originalEnv)) {
            delete process.env[key]
        }
    }

    Object.assign(process.env, originalEnv)
}

async function loadEmailVerificationService() {
    process.env['FRONTEND_URL'] = 'https://app.example.com'
    process.env['APP_URL'] = 'https://app.example.com'
    return import('./email-verification-service.js')
}

beforeEach(() => {
    consumeAuthThrottleMock.mockReset()
    consumeAuthThrottleMock.mockResolvedValue({ allowed: true, count: 1 })
})

afterEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    restoreEnv()
})

describe('emailVerificationService', () => {
    it('sends a verification email for an unverified user', async () => {
        userRepositoryMock.lockById.mockResolvedValue({
            id: 7n,
            name: 'Jane',
            email: 'jane@example.com',
            emailVerifiedAt: null,
        })
        emailVerificationRepositoryMock.invalidatePendingByUserId.mockResolvedValue(1)
        emailVerificationRepositoryMock.create.mockResolvedValue({
            id: 11n,
            userId: 7n,
        })
        emailServiceMock.send.mockResolvedValue(
            Result.ok({
                accepted: ['jane@example.com'],
                messageId: 'message-id',
                rejected: [],
                response: '250 OK',
            }),
        )

        const { emailVerificationService } = await loadEmailVerificationService()
        const result = await emailVerificationService.sendVerificationEmail(7n)

        expect(Result.isOk(result)).toBe(true)
        if (Result.isOk(result)) {
            expect(result.value).toEqual({ message: 'Verification email sent' })
        }
        // feat-096: issued under the user lock, in the same transaction.
        expect(userRepositoryMock.lockById).toHaveBeenCalledWith(7n, TX)
        expect(emailVerificationRepositoryMock.invalidatePendingByUserId).toHaveBeenCalledWith(
            7n,
            TX,
        )
        expect(emailVerificationRepositoryMock.create).toHaveBeenCalledTimes(1)
        expect(emailVerificationRepositoryMock.create).toHaveBeenCalledWith(
            expect.objectContaining({ userId: 7n }),
            TX,
        )
        expect(emailServiceMock.send).toHaveBeenCalledWith(
            expect.objectContaining({
                to: 'jane@example.com',
                subject: 'Confirm your email',
            }),
        )
    })

    it('returns success when the user is already verified', async () => {
        userRepositoryMock.findById.mockResolvedValue({
            id: 7n,
            emailVerifiedAt: new Date(),
        })

        const { emailVerificationService } = await loadEmailVerificationService()
        const result = await emailVerificationService.queueVerificationEmail(7n, sessionStillStored)

        expect(Result.isOk(result)).toBe(true)
        if (Result.isOk(result)) {
            expect(result.value).toEqual({ message: 'Email is already verified' })
        }
    })

    it('rejects expired verification links', async () => {
        emailVerificationRepositoryMock.findByTokenHash.mockResolvedValue({
            id: 11n,
            userId: 7n,
            tokenHash: 'hash',
            expiresAt: new Date(Date.now() - 1000),
            usedAt: null,
            createdAt: new Date(),
        })
        emailVerificationRepositoryMock.burn.mockResolvedValue(undefined)

        const { emailVerificationService } = await loadEmailVerificationService()
        const result = await emailVerificationService.verifyEmail(
            'expired-token',
            { ipAddress: '127.0.0.1' },
            ANONYMOUS,
        )

        expect(Result.isError(result)).toBe(true)
        if (Result.isError(result)) {
            expect(result.error).toEqual({
                _tag: 'BadRequest',
                message: 'Verification link has expired',
            })
        }
        expect(emailVerificationRepositoryMock.burn).toHaveBeenCalledWith(11n)
        expect(emailVerificationRepositoryMock.markUsed).not.toHaveBeenCalled()
        expect(userRepositoryMock.update).not.toHaveBeenCalled()
    })

    it('verifies an unverified user and marks the token used', async () => {
        emailVerificationRepositoryMock.findByTokenHash.mockResolvedValue({
            id: 11n,
            userId: 7n,
            tokenHash: 'hash',
            expiresAt: new Date(Date.now() + 60_000),
            usedAt: null,
            createdAt: new Date(),
        })
        userRepositoryMock.findById.mockResolvedValue({
            id: 7n,
            emailVerifiedAt: null,
            sessionToken: 'session-7',
        })
        userRepositoryMock.lockById.mockResolvedValue({
            id: 7n,
            emailVerifiedAt: null,
        })
        userRepositoryMock.update.mockResolvedValue({
            id: 7n,
            emailVerifiedAt: new Date(),
        })
        emailVerificationRepositoryMock.markUsed.mockResolvedValue({
            id: 11n,
            usedAt: new Date(),
        })

        const { emailVerificationService } = await loadEmailVerificationService()
        const result = await emailVerificationService.verifyEmail(
            'valid-token',
            { ipAddress: '127.0.0.1' },
            OWN_SESSION_7,
        )

        expect(Result.isOk(result)).toBe(true)
        if (Result.isOk(result)) {
            expect(result.value).toEqual({
                message: 'Email confirmed successfully',
            })
        }
        expect(userRepositoryMock.update).toHaveBeenCalledWith(
            7n,
            {
                emailVerifiedAt: expect.any(Date),
            },
            TX,
        )
        expect(userRepositoryMock.lockById).toHaveBeenCalledWith(7n, TX)
        expect(emailVerificationRepositoryMock.markUsed).toHaveBeenCalledWith(11n, TX)
        // The user's other pending verification links are retired with the claim.
        expect(emailVerificationRepositoryMock.invalidatePendingByUserId).toHaveBeenCalledWith(
            7n,
            TX,
        )
    })

    // ADR 0004: an infrastructure failure throws; the background sender catches it and
    // logs it once as error with the cause (nobody else would).
    it('logs a thrown failure in the background sender once, with the cause', async () => {
        const dbError = new Error('db down')
        userRepositoryMock.lockById.mockRejectedValue(dbError)

        const { emailVerificationService } = await loadEmailVerificationService()

        await emailVerificationService.sendVerificationEmailInBackground(7n, 'manual resend')

        expect(loggerMock.error).toHaveBeenCalledTimes(1)
        expect(loggerMock.error).toHaveBeenCalledWith(
            expect.objectContaining({ err: dbError, userId: '7', trigger: 'manual resend' }),
            'Unexpected error while sending verification email in background',
        )
    })

    it('sends an email link verification for a phone-only account', async () => {
        userRepositoryMock.lockById.mockResolvedValue({
            id: 8n,
            name: 'Jane',
            email: null,
            emailVerifiedAt: null,
            sessionToken: 'session-8',
        })
        emailLinkVerificationRepositoryMock.invalidatePendingByUserId.mockResolvedValue(0)
        emailLinkVerificationRepositoryMock.create.mockResolvedValue({
            id: 12n,
            userId: 8n,
        })
        emailServiceMock.send.mockResolvedValue(
            Result.ok({
                accepted: ['new@example.com'],
                messageId: 'message-id',
                rejected: [],
                response: '250 OK',
            }),
        )

        const { emailVerificationService } = await loadEmailVerificationService()
        const result = await emailVerificationService.sendLinkVerificationEmail(
            8n,
            'new@example.com',
            'session-8',
        )

        expect(Result.isOk(result)).toBe(true)
        expect(userRepositoryMock.lockById).toHaveBeenCalledWith(8n, TX)
        expect(emailLinkVerificationRepositoryMock.create).toHaveBeenCalledTimes(1)
        expect(emailLinkVerificationRepositoryMock.create).toHaveBeenCalledWith(
            expect.objectContaining({ userId: 8n, targetEmail: 'new@example.com' }),
            TX,
        )
        expect(emailServiceMock.send).toHaveBeenCalledWith(
            expect.objectContaining({
                to: 'new@example.com',
                subject: 'Confirm your new email',
            }),
        )
    })

    // feat-060: a concurrent request claimed the token first (markUsed -> undefined).
    it('does not confirm the email when another request already claimed the token', async () => {
        emailVerificationRepositoryMock.findByTokenHash.mockResolvedValue({
            id: 11n,
            userId: 7n,
            tokenHash: 'hash',
            expiresAt: new Date(Date.now() + 60_000),
            usedAt: null,
            createdAt: new Date(),
        })
        userRepositoryMock.findById.mockResolvedValue({
            id: 7n,
            emailVerifiedAt: null,
            sessionToken: 'session-7',
        })
        userRepositoryMock.lockById.mockResolvedValue({ id: 7n, emailVerifiedAt: null })
        emailVerificationRepositoryMock.markUsed.mockResolvedValue(undefined)

        const { emailVerificationService } = await loadEmailVerificationService()
        const result = await emailVerificationService.verifyEmail(
            'raced-token',
            { ipAddress: '127.0.0.1' },
            OWN_SESSION_7,
        )

        expect(Result.isError(result)).toBe(true)
        if (Result.isError(result)) {
            expect(result.error).toEqual({
                _tag: 'BadRequest',
                message: 'Verification link has already been used',
            })
        }
        expect(userRepositoryMock.update).not.toHaveBeenCalled()
    })

    it('does not link the email when another request already claimed the token', async () => {
        emailVerificationRepositoryMock.findByTokenHash.mockResolvedValue(undefined)
        emailLinkVerificationRepositoryMock.findByTokenHash.mockResolvedValue({
            id: 15n,
            userId: 8n,
            targetEmail: 'new@example.com',
            tokenHash: 'hash',
            expiresAt: new Date(Date.now() + 60_000),
            usedAt: null,
            createdAt: new Date(),
        })
        userRepositoryMock.lockById.mockResolvedValue({
            id: 8n,
            email: null,
            sessionToken: 'session-8',
        })
        userRepositoryMock.findByEmail.mockResolvedValue(undefined)
        emailLinkVerificationRepositoryMock.markUsed.mockResolvedValue(undefined)

        const { emailVerificationService } = await loadEmailVerificationService()
        const result = await emailVerificationService.verifyEmail(
            'raced-link',
            { ipAddress: '127.0.0.1' },
            OWN_SESSION_8,
        )

        expect(Result.isError(result)).toBe(true)
        if (Result.isError(result)) {
            expect(result.error).toEqual({
                _tag: 'BadRequest',
                message: 'Verification link has already been used',
            })
        }
        expect(userRepositoryMock.update).not.toHaveBeenCalled()
    })

    it('verifies a pending email-link token and links the new email', async () => {
        emailVerificationRepositoryMock.findByTokenHash.mockResolvedValue(undefined)
        emailLinkVerificationRepositoryMock.findByTokenHash.mockResolvedValue({
            id: 15n,
            userId: 8n,
            targetEmail: 'new@example.com',
            tokenHash: 'hash',
            expiresAt: new Date(Date.now() + 60_000),
            usedAt: null,
            createdAt: new Date(),
        })
        userRepositoryMock.lockById.mockResolvedValue({
            id: 8n,
            email: null,
            sessionToken: 'session-8',
        })
        userRepositoryMock.findByEmail.mockResolvedValue(undefined)
        userRepositoryMock.update.mockResolvedValue({
            id: 8n,
            email: 'new@example.com',
            emailVerifiedAt: new Date(),
        })
        emailLinkVerificationRepositoryMock.markUsed.mockResolvedValue({
            id: 15n,
            usedAt: new Date(),
        })

        const { emailVerificationService } = await loadEmailVerificationService()
        const result = await emailVerificationService.verifyEmail(
            'link-token',
            { ipAddress: '127.0.0.1' },
            OWN_SESSION_8,
        )

        expect(Result.isOk(result)).toBe(true)
        expect(userRepositoryMock.update).toHaveBeenCalledWith(
            8n,
            expect.objectContaining({
                email: 'new@example.com',
                emailVerifiedAt: expect.any(Date),
            }),
            TX,
        )
        expect(userRepositoryMock.lockById).toHaveBeenCalledWith(8n, TX)
        expect(emailLinkVerificationRepositoryMock.markUsed).toHaveBeenCalledWith(15n, TX)
        expect(emailLinkVerificationRepositoryMock.invalidatePendingByUserId).toHaveBeenCalledWith(
            8n,
            TX,
        )
    })

    // feat-096: the account got an address after the link was mailed (another link, a
    // change); the locked row says so, the link is spent and nothing is overwritten.
    it('does not link the email when the locked user already has one', async () => {
        emailVerificationRepositoryMock.findByTokenHash.mockResolvedValue(undefined)
        emailLinkVerificationRepositoryMock.findByTokenHash.mockResolvedValue({
            id: 15n,
            userId: 8n,
            targetEmail: 'new@example.com',
            tokenHash: 'hash',
            expiresAt: new Date(Date.now() + 60_000),
            usedAt: null,
            createdAt: new Date(),
        })
        userRepositoryMock.findByEmail.mockResolvedValue(undefined)
        userRepositoryMock.lockById.mockResolvedValue({
            id: 8n,
            email: 'other@example.com',
            sessionToken: 'session-8',
        })
        emailLinkVerificationRepositoryMock.markUsed.mockResolvedValue({
            id: 15n,
            usedAt: new Date(),
        })

        const { emailVerificationService } = await loadEmailVerificationService()
        const result = await emailVerificationService.verifyEmail(
            'link-token',
            { ipAddress: '127.0.0.1' },
            OWN_SESSION_8,
        )

        expect(Result.isError(result)).toBe(true)
        if (Result.isError(result)) {
            expect(result.error).toEqual({
                _tag: 'Conflict',
                message: 'Email is already linked to this account',
            })
        }
        expect(userRepositoryMock.lockById).toHaveBeenCalledWith(8n, TX)
        expect(emailLinkVerificationRepositoryMock.markUsed).toHaveBeenCalledWith(15n, TX)
        expect(userRepositoryMock.update).not.toHaveBeenCalled()
        expect(emailLinkVerificationRepositoryMock.invalidatePendingByUserId).not.toHaveBeenCalled()
    })
})

describe('sendLinkVerificationEmail session guard (feat-096)', () => {
    it.each([
        ['a rotated session token', 'session-old'],
        ['no presented session token', undefined],
    ])(
        'refuses with session_revoked for %s, issues no token and sends no mail',
        async (_n, presented) => {
            userRepositoryMock.lockById.mockResolvedValue({
                id: 8n,
                name: 'Jane',
                email: null,
                emailVerifiedAt: null,
                sessionToken: 'session-current',
            })

            const { emailVerificationService } = await loadEmailVerificationService()
            const result = await emailVerificationService.sendLinkVerificationEmail(
                8n,
                'new@example.com',
                presented,
            )

            expect(Result.isError(result)).toBe(true)
            if (Result.isError(result)) {
                expect(result.error).toEqual({
                    _tag: 'Unauthorized',
                    message: 'Session has been revoked',
                    reason: 'session_revoked',
                })
            }
            expect(userRepositoryMock.lockById).toHaveBeenCalledWith(8n, TX)
            expect(
                emailLinkVerificationRepositoryMock.invalidatePendingByUserId,
            ).not.toHaveBeenCalled()
            expect(emailLinkVerificationRepositoryMock.create).not.toHaveBeenCalled()
            expect(emailServiceMock.send).not.toHaveBeenCalled()
        },
    )

    it('refuses when the locked user already has an email, issues no token and sends no mail', async () => {
        userRepositoryMock.lockById.mockResolvedValue({
            id: 8n,
            name: 'Jane',
            email: 'jane@example.com',
            emailVerifiedAt: new Date(),
            sessionToken: 'session-8',
        })

        const { emailVerificationService } = await loadEmailVerificationService()
        const result = await emailVerificationService.sendLinkVerificationEmail(
            8n,
            'new@example.com',
            'session-8',
        )

        expect(Result.isError(result)).toBe(true)
        if (Result.isError(result)) {
            expect(result.error).toEqual({
                _tag: 'BadRequest',
                message: 'Email is already linked to this account',
            })
        }
        expect(emailLinkVerificationRepositoryMock.invalidatePendingByUserId).not.toHaveBeenCalled()
        expect(emailLinkVerificationRepositoryMock.create).not.toHaveBeenCalled()
        expect(emailServiceMock.send).not.toHaveBeenCalled()
    })
})

it('maps a unique email race during link verification to a conflict', async () => {
    emailVerificationRepositoryMock.findByTokenHash.mockResolvedValue(undefined)
    emailLinkVerificationRepositoryMock.findByTokenHash.mockResolvedValue({
        id: 16n,
        userId: 8n,
        targetEmail: 'new@example.com',
        tokenHash: 'hash',
        expiresAt: new Date(Date.now() + 60_000),
        usedAt: null,
        createdAt: new Date(),
    })
    userRepositoryMock.lockById.mockResolvedValue({
        id: 8n,
        email: null,
        sessionToken: 'session-8',
    })
    userRepositoryMock.findByEmail.mockResolvedValue(undefined)
    userRepositoryMock.update.mockRejectedValue({ code: '23505' })
    emailLinkVerificationRepositoryMock.markUsed.mockResolvedValue({ id: 16n, usedAt: new Date() })

    const { emailVerificationService } = await loadEmailVerificationService()
    const result = await emailVerificationService.verifyEmail(
        'link-token',
        { ipAddress: '127.0.0.1' },
        OWN_SESSION_8,
    )

    expect(Result.isError(result)).toBe(true)
    if (Result.isError(result)) {
        expect(result.error).toEqual({
            _tag: 'Conflict',
            message: 'Email is already linked to another account',
        })
    }
    // The claim ran in the same transaction as the failed update, so it is rolled back
    // with it (proved against PostgreSQL); here it is only handed that transaction.
    expect(emailLinkVerificationRepositoryMock.markUsed).toHaveBeenCalledWith(16n, TX)
})

describe('verification throttles', () => {
    it.each([
        [
            'the budget is spent',
            () => consumeAuthThrottleMock.mockResolvedValue({ allowed: false, count: 21 }),
        ],
        ['Redis fails', () => consumeAuthThrottleMock.mockRejectedValue(new Error('redis down'))],
    ])('verify email: rejected without checking the token when %s', async (_n, arrange) => {
        arrange()
        const { emailVerificationService } = await loadEmailVerificationService()
        // A spent budget answers Result.err; a Redis failure rejects (ADR 0004). Both refuse.
        const refused = await emailVerificationService
            .verifyEmail('some-token', { ipAddress: '10.0.0.5' }, ANONYMOUS)
            .then(
                (result) => Result.isError(result),
                () => true,
            )
        expect(refused).toBe(true)
        expect(emailVerificationRepositoryMock.findByTokenHash).not.toHaveBeenCalled()
        expect(consumeAuthThrottleMock).toHaveBeenCalledWith(
            expect.objectContaining({ scope: 'verify_email_ip' }),
            '10.0.0.5',
        )
    })

    it.each([
        [
            'the budget is spent',
            () => consumeAuthThrottleMock.mockResolvedValue({ allowed: false, count: 4 }),
        ],
        ['Redis fails', () => consumeAuthThrottleMock.mockRejectedValue(new Error('redis down'))],
    ])('resend verification: no email queued when %s', async (_n, arrange) => {
        arrange()
        const { emailVerificationService } = await loadEmailVerificationService()
        // A spent budget answers Result.err; a Redis failure rejects (ADR 0004). Both refuse.
        const refused = await emailVerificationService
            .queueVerificationEmail(7n, sessionStillStored)
            .then(
                (result) => Result.isError(result),
                () => true,
            )
        expect(refused).toBe(true)
        expect(userRepositoryMock.findById).not.toHaveBeenCalled()
        expect(emailVerificationRepositoryMock.create).not.toHaveBeenCalled()
        expect(emailServiceMock.send).not.toHaveBeenCalled()
        expect(consumeAuthThrottleMock).toHaveBeenCalledWith(
            expect.objectContaining({ scope: 'resend_verification_user' }),
            '7',
        )
    })
})

// feat-097: a registration link confirms the account only for its owner: a session of that
// account, or the account's password. A refusal before the transaction leaves the link usable.
describe('verifyEmail · the owner of a registration link', () => {
    const registrationToken = () => ({
        id: 11n,
        userId: 7n,
        tokenHash: 'hash',
        expiresAt: new Date(Date.now() + 60_000),
        usedAt: null,
        createdAt: new Date(),
    })
    const owner = (over: Record<string, unknown> = {}) => ({
        id: 7n,
        email: 'jane@example.com',
        emailVerifiedAt: null,
        password: 'stored-hash',
        sessionToken: 'session-7',
        ...over,
    })

    function arrange(over: Record<string, unknown> = {}): void {
        emailVerificationRepositoryMock.findByTokenHash.mockResolvedValue(registrationToken())
        userRepositoryMock.findById.mockResolvedValue(owner(over))
        userRepositoryMock.lockById.mockResolvedValue(owner(over))
        userRepositoryMock.update.mockResolvedValue(owner({ emailVerifiedAt: new Date() }))
        emailVerificationRepositoryMock.markUsed.mockResolvedValue({ id: 11n })
    }

    const verify = async (requester: Requester) => {
        const { emailVerificationService } = await loadEmailVerificationService()
        return emailVerificationService.verifyEmail(
            'reg-token',
            { ipAddress: '10.0.0.1' },
            requester,
        )
    }

    const expectNotConsumed = (): void => {
        expect(emailVerificationRepositoryMock.markUsed).not.toHaveBeenCalled()
        expect(userRepositoryMock.lockById).not.toHaveBeenCalled()
        expect(userRepositoryMock.update).not.toHaveBeenCalled()
    }

    it('its own current session confirms without a password', async () => {
        arrange()

        const result = await verify(OWN_SESSION_7)

        expect(Result.isOk(result)).toBe(true)
        expect(validatePasswordMock).not.toHaveBeenCalled()
        expect(emailVerificationRepositoryMock.markUsed).toHaveBeenCalledWith(11n, TX)
        expect(userRepositoryMock.update).toHaveBeenCalledWith(
            7n,
            { emailVerifiedAt: expect.any(Date) },
            TX,
        )
    })

    it.each([
        ['nobody signed in', ANONYMOUS],
        ['another account', { userId: 9n, presentedSessionToken: 'session-7' }],
        ['a revoked session of the account', { userId: 7n, presentedSessionToken: 'old-session' }],
        ['the account without a presented token', { userId: 7n, presentedSessionToken: undefined }],
    ])('%s without a password: 403 password_required, the link is not used', async (_n, who) => {
        arrange()

        const result = await verify(who)

        expect(Result.isError(result) && result.error).toEqual({
            _tag: 'Forbidden',
            message: 'Enter the password of this account to confirm the email',
            reason: 'password_required',
        })
        expect(validatePasswordMock).not.toHaveBeenCalled()
        expectNotConsumed()
    })

    it('an empty password is a missing one', async () => {
        arrange()

        const result = await verify({ ...ANONYMOUS, password: '' })

        expect(Result.isError(result) && result.error).toMatchObject({
            _tag: 'Forbidden',
            reason: 'password_required',
        })
        expectNotConsumed()
    })

    it('a wrong password: 400 invalid_password, the link is not used', async () => {
        arrange()
        validatePasswordMock.mockResolvedValue(false)

        const result = await verify({ ...ANONYMOUS, password: 'guess' })

        expect(Result.isError(result) && result.error).toEqual({
            _tag: 'BadRequest',
            message: 'Password is incorrect',
            reason: 'invalid_password',
        })
        expect(validatePasswordMock).toHaveBeenCalledWith('guess', 'stored-hash')
        expectNotConsumed()
    })

    it('an account without a password cannot be confirmed by one', async () => {
        arrange({ password: null })

        const result = await verify({ ...ANONYMOUS, password: 'anything' })

        expect(Result.isError(result) && result.error).toMatchObject({
            _tag: 'BadRequest',
            reason: 'invalid_password',
        })
        expect(validatePasswordMock).not.toHaveBeenCalled()
        expectNotConsumed()
    })

    it('the right password confirms from another browser', async () => {
        arrange()
        validatePasswordMock.mockResolvedValue(true)

        const result = await verify({ ...ANONYMOUS, password: 'secret' })

        expect(Result.isOk(result) && result.value).toEqual({
            message: 'Email confirmed successfully',
        })
        expect(consumeAuthThrottleMock).toHaveBeenCalledWith(
            expect.objectContaining({ scope: 'verify_email_password_user' }),
            '7',
        )
        expect(emailVerificationRepositoryMock.markUsed).toHaveBeenCalledWith(11n, TX)
    })

    it('password attempts are throttled per user before the password is checked', async () => {
        arrange()
        consumeAuthThrottleMock.mockImplementation((policy: { scope: string }) =>
            Promise.resolve(
                policy.scope === 'verify_email_password_user'
                    ? { allowed: false, count: 6 }
                    : { allowed: true, count: 1 },
            ),
        )

        const result = await verify({ ...ANONYMOUS, password: 'guess' })

        expect(Result.isError(result) && result.error).toEqual({
            _tag: 'BadRequest',
            message: 'Too many verification attempts. Please try again later.',
        })
        expect(validatePasswordMock).not.toHaveBeenCalled()
        expectNotConsumed()
    })

    it('an already verified account skips the owner check', async () => {
        arrange({ emailVerifiedAt: new Date() })

        const result = await verify(ANONYMOUS)

        expect(Result.isOk(result)).toBe(true)
        expect(validatePasswordMock).not.toHaveBeenCalled()
        expect(consumeAuthThrottleMock).not.toHaveBeenCalledWith(
            expect.objectContaining({ scope: 'verify_email_password_user' }),
            expect.anything(),
        )
        expect(userRepositoryMock.update).not.toHaveBeenCalled()
    })

    it('a token whose user is gone answers not found', async () => {
        arrange()
        userRepositoryMock.findById.mockResolvedValue(undefined)

        const result = await verify(OWN_SESSION_7)

        expect(Result.isError(result) && result.error).toMatchObject({ _tag: 'NotFound' })
        expectNotConsumed()
    })
})

// feat-097: an email link works only in a session of the account that asked for it.
describe('verifyEmail · the session of an email link', () => {
    function arrange(): void {
        emailVerificationRepositoryMock.findByTokenHash.mockResolvedValue(undefined)
        emailLinkVerificationRepositoryMock.findByTokenHash.mockResolvedValue({
            id: 15n,
            userId: 8n,
            targetEmail: 'new@example.com',
            tokenHash: 'hash',
            expiresAt: new Date(Date.now() + 60_000),
            usedAt: null,
            createdAt: new Date(),
        })
        userRepositoryMock.findByEmail.mockResolvedValue(undefined)
        userRepositoryMock.lockById.mockResolvedValue({
            id: 8n,
            email: null,
            sessionToken: 'session-8',
        })
        emailLinkVerificationRepositoryMock.markUsed.mockResolvedValue({ id: 15n })
    }

    const verify = async (requester: Requester) => {
        const { emailVerificationService } = await loadEmailVerificationService()
        return emailVerificationService.verifyEmail(
            'link-token',
            { ipAddress: '10.0.0.1' },
            requester,
        )
    }

    it.each([
        ['nobody signed in', ANONYMOUS],
        ['another account', { userId: 9n, presentedSessionToken: 'session-9' }],
    ])('%s: 403 email_link_wrong_session, the link is not used', async (_n, who) => {
        arrange()

        const result = await verify(who)

        expect(Result.isError(result) && result.error).toEqual({
            _tag: 'Forbidden',
            message: 'Open this link while signed in to the account that asked for it',
            reason: 'email_link_wrong_session',
        })
        expect(userRepositoryMock.lockById).not.toHaveBeenCalled()
        expect(emailLinkVerificationRepositoryMock.markUsed).not.toHaveBeenCalled()
        expect(userRepositoryMock.update).not.toHaveBeenCalled()
    })

    it('a password does not stand in for the session', async () => {
        arrange()

        const result = await verify({ ...ANONYMOUS, password: 'secret' })

        expect(Result.isError(result) && result.error).toMatchObject({
            reason: 'email_link_wrong_session',
        })
        expect(validatePasswordMock).not.toHaveBeenCalled()
    })

    it('a revoked session of the account: 401 session_revoked, nothing linked', async () => {
        arrange()

        const result = await verify({ userId: 8n, presentedSessionToken: 'session-old' })

        expect(Result.isError(result) && result.error).toEqual({
            _tag: 'Unauthorized',
            message: 'Session has been revoked',
            reason: 'session_revoked',
        })
        expect(userRepositoryMock.lockById).toHaveBeenCalledWith(8n, TX)
        expect(userRepositoryMock.update).not.toHaveBeenCalled()
    })
})
