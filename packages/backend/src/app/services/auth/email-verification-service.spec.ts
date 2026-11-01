import { Result } from 'better-result'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const userRepositoryMock = {
    findById: vi.fn(),
    findByEmail: vi.fn(),
    update: vi.fn(),
}

const emailVerificationRepositoryMock = {
    create: vi.fn(),
    findByTokenHash: vi.fn(),
    invalidatePendingByUserId: vi.fn(),
    markUsed: vi.fn(),
}
const emailLinkVerificationRepositoryMock = {
    create: vi.fn(),
    findByTokenHash: vi.fn(),
    invalidatePendingByUserId: vi.fn(),
    markUsed: vi.fn(),
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
        userRepositoryMock.findById.mockResolvedValue({
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
        expect(emailVerificationRepositoryMock.invalidatePendingByUserId).toHaveBeenCalledWith(7n)
        expect(emailVerificationRepositoryMock.create).toHaveBeenCalledTimes(1)
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
        const result = await emailVerificationService.queueVerificationEmail(7n)

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
        emailVerificationRepositoryMock.markUsed.mockResolvedValue({ id: 11n })

        const { emailVerificationService } = await loadEmailVerificationService()
        const result = await emailVerificationService.verifyEmail('expired-token', {
            ipAddress: '127.0.0.1',
        })

        expect(Result.isError(result)).toBe(true)
        if (Result.isError(result)) {
            expect(result.error).toEqual({
                _tag: 'BadRequest',
                message: 'Verification link has expired',
            })
        }
        expect(emailVerificationRepositoryMock.markUsed).toHaveBeenCalledWith(11n)
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
        const result = await emailVerificationService.verifyEmail('valid-token', {
            ipAddress: '127.0.0.1',
        })

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
        expect(emailVerificationRepositoryMock.markUsed).toHaveBeenCalledWith(11n, undefined, TX)
    })

    it('keeps background logging on service failure', async () => {
        userRepositoryMock.findById.mockRejectedValue(new Error('db down'))

        const { emailVerificationService } = await loadEmailVerificationService()

        await emailVerificationService.sendVerificationEmailInBackground(7n, 'manual resend')

        expect(loggerMock.warn).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: '7',
                reason: 'Failed to load user',
                trigger: 'manual resend',
            }),
            'Failed to send verification email in background',
        )
    })

    it('sends an email link verification for a phone-only account', async () => {
        userRepositoryMock.findById.mockResolvedValue({
            id: 8n,
            name: 'Jane',
            email: null,
            emailVerifiedAt: null,
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
        )

        expect(Result.isOk(result)).toBe(true)
        expect(emailLinkVerificationRepositoryMock.create).toHaveBeenCalledTimes(1)
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
        userRepositoryMock.findById.mockResolvedValue({ id: 7n, emailVerifiedAt: null })
        emailVerificationRepositoryMock.markUsed.mockResolvedValue(undefined)

        const { emailVerificationService } = await loadEmailVerificationService()
        const result = await emailVerificationService.verifyEmail('raced-token', {
            ipAddress: '127.0.0.1',
        })

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
        userRepositoryMock.findById.mockResolvedValue({ id: 8n, email: null })
        userRepositoryMock.findByEmail.mockResolvedValue(undefined)
        emailLinkVerificationRepositoryMock.markUsed.mockResolvedValue(undefined)

        const { emailVerificationService } = await loadEmailVerificationService()
        const result = await emailVerificationService.verifyEmail('raced-link', {
            ipAddress: '127.0.0.1',
        })

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
        userRepositoryMock.findById.mockResolvedValue({
            id: 8n,
            email: null,
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
        const result = await emailVerificationService.verifyEmail('link-token', {
            ipAddress: '127.0.0.1',
        })

        expect(Result.isOk(result)).toBe(true)
        expect(userRepositoryMock.update).toHaveBeenCalledWith(
            8n,
            expect.objectContaining({
                email: 'new@example.com',
                emailVerifiedAt: expect.any(Date),
            }),
            TX,
        )
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
    userRepositoryMock.findById.mockResolvedValue({
        id: 8n,
        email: null,
    })
    userRepositoryMock.findByEmail.mockResolvedValue(undefined)
    userRepositoryMock.update.mockRejectedValue({ code: '23505' })

    const { emailVerificationService } = await loadEmailVerificationService()
    const result = await emailVerificationService.verifyEmail('link-token', {
        ipAddress: '127.0.0.1',
    })

    expect(Result.isError(result)).toBe(true)
    if (Result.isError(result)) {
        expect(result.error).toEqual({
            _tag: 'Conflict',
            message: 'Email is already linked to another account',
        })
    }
    // The claim ran in the same transaction as the failed update, so it is rolled back
    // with it (proved against PostgreSQL); here it is only handed that transaction.
    expect(emailLinkVerificationRepositoryMock.markUsed).toHaveBeenCalledWith(
        expect.anything(),
        undefined,
        TX,
    )
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
        const result = await emailVerificationService.verifyEmail('some-token', {
            ipAddress: '10.0.0.5',
        })
        expect(Result.isError(result)).toBe(true)
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
        const result = await emailVerificationService.queueVerificationEmail(7n)
        expect(Result.isError(result)).toBe(true)
        expect(userRepositoryMock.findById).not.toHaveBeenCalled()
        expect(emailVerificationRepositoryMock.create).not.toHaveBeenCalled()
        expect(emailServiceMock.send).not.toHaveBeenCalled()
        expect(consumeAuthThrottleMock).toHaveBeenCalledWith(
            expect.objectContaining({ scope: 'resend_verification_user' }),
            '7',
        )
    })
})
