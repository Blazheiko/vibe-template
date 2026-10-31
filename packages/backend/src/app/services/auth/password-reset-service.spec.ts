import { Result } from 'better-result'
import { createHmac } from 'node:crypto'
import { PENDING_SMS_CODE_HASH_PLACEHOLDER } from './sms-auth-challenge-constants.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const userRepositoryMock = {
    findByEmail: vi.fn(),
    findById: vi.fn(),
    findByPhone: vi.fn(),
    update: vi.fn(),
}

const passwordResetRepositoryMock = {
    create: vi.fn(),
    findByTokenHash: vi.fn(),
    invalidatePendingByUserId: vi.fn(),
    markUsed: vi.fn(),
}
const smsAuthChallengeRepositoryMock = {
    create: vi.fn(),
    findById: vi.fn(),
    findLatestPendingForPhoneFlow: vi.fn(),
    invalidatePendingForPhoneFlow: vi.fn(),
    incrementAttemptCount: vi.fn(),
    markConfirmed: vi.fn(),
    markInvalidated: vi.fn(),
    markIssued: vi.fn(),
}

const emailServiceMock = {
    send: vi.fn(),
}

const destroyAllSessionsMock = vi.fn()
const hashPasswordMock = vi.fn()
const nanoidMock = vi.fn(() => 'new-session-token')
const consumeAuthThrottleMock = vi.fn()
const resetAuthThrottleMock = vi.fn()
const issueVerificationCodeMock = vi.fn()
const loggerMock = {
    warn: vi.fn(),
    error: vi.fn(),
}

const originalEnv = { ...process.env }

vi.mock('#app/repositories/index.js', () => ({
    userRepository: userRepositoryMock,
    passwordResetRepository: passwordResetRepositoryMock,
    smsAuthChallengeRepository: smsAuthChallengeRepositoryMock,
}))

vi.mock('#app/services/notifications/email-service.js', () => ({
    emailService: emailServiceMock,
}))

vi.mock('#vendor/utils/session/redis-session-storage.js', () => ({
    destroyAllSessions: destroyAllSessionsMock,
}))

vi.mock('#app/services/auth/auth-throttle-service.js', () => ({
    consumeAuthThrottle: consumeAuthThrottleMock,
    resetAuthThrottle: resetAuthThrottleMock,
}))

vi.mock('#app/services/auth/sms-verification-provider.js', () => ({
    smsVerificationProvider: {
        issueVerificationCode: issueVerificationCodeMock,
    },
}))

vi.mock('metautil', () => ({
    hashPassword: hashPasswordMock,
}))

vi.mock('nanoid', () => ({
    nanoid: nanoidMock,
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

async function loadPasswordResetService() {
    process.env['FRONTEND_URL'] = 'https://app.example.com'
    process.env['APP_URL'] = 'https://app.example.com'
    process.env['APP_KEY'] = 'a'.repeat(32)
    process.env['AUTH_PHONE_ENABLED'] = 'true'
    return import('./password-reset-service.js')
}

function hashOtp(code: string): string {
    return createHmac('sha256', 'a'.repeat(32)).update(code).digest('hex')
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

describe('passwordResetService', () => {
    it('returns generic success for unknown email', async () => {
        userRepositoryMock.findByEmail.mockResolvedValue(undefined)

        const { passwordResetService } = await loadPasswordResetService()
        const result = await passwordResetService.requestPasswordReset('missing@example.com', {
            ipAddress: '127.0.0.1',
        })

        expect(Result.isOk(result)).toBe(true)
        if (Result.isOk(result)) {
            expect(result.value).toEqual({
                message: 'If an account with that email exists, a reset link will be sent shortly.',
            })
        }
        expect(userRepositoryMock.findByEmail).toHaveBeenCalledWith('missing@example.com')
    })

    it('queues background reset email for known email', async () => {
        userRepositoryMock.findByEmail.mockResolvedValue({
            id: 7n,
        })

        const { passwordResetService } = await loadPasswordResetService()
        const backgroundSpy = vi
            .spyOn(passwordResetService, 'sendPasswordResetEmailInBackground')
            .mockResolvedValue()

        const result = await passwordResetService.requestPasswordReset('User@example.com', {
            ipAddress: '127.0.0.1',
        })

        expect(Result.isOk(result)).toBe(true)
        expect(userRepositoryMock.findByEmail).toHaveBeenCalledWith('user@example.com')
        expect(backgroundSpy).toHaveBeenCalledWith(7n, 'manual request')
    })

    it('keeps forgot password generic when loading the user fails', async () => {
        userRepositoryMock.findByEmail.mockRejectedValue(new Error('db down'))

        const { passwordResetService } = await loadPasswordResetService()
        const result = await passwordResetService.requestPasswordReset('User@example.com', {
            ipAddress: '127.0.0.1',
        })

        expect(Result.isOk(result)).toBe(true)
        if (Result.isOk(result)) {
            expect(result.value).toEqual({
                message: 'If an account with that email exists, a reset link will be sent shortly.',
            })
        }
    })

    it('creates a token and sends email', async () => {
        userRepositoryMock.findById.mockResolvedValue({
            id: 7n,
            name: 'Jane',
            email: 'jane@example.com',
        })
        passwordResetRepositoryMock.invalidatePendingByUserId.mockResolvedValue(1)
        passwordResetRepositoryMock.create.mockImplementation(
            async (data: { userId: bigint; tokenHash: string; expiresAt: Date }) => ({
                id: 11n,
                usedAt: null,
                createdAt: new Date(),
                ...data,
            }),
        )
        emailServiceMock.send.mockResolvedValue(
            Result.ok({
                accepted: ['jane@example.com'],
                messageId: 'message-id',
                rejected: [],
                response: '250 OK',
            }),
        )

        const { passwordResetService } = await loadPasswordResetService()
        const result = await passwordResetService.sendPasswordResetEmail(7n)

        expect(Result.isOk(result)).toBe(true)
        expect(passwordResetRepositoryMock.invalidatePendingByUserId).toHaveBeenCalledWith(7n)
        expect(passwordResetRepositoryMock.create).toHaveBeenCalledTimes(1)

        const createArg = passwordResetRepositoryMock.create.mock.calls[0]?.[0]
        expect(createArg.userId).toBe(7n)
        expect(createArg.tokenHash).toMatch(/^[a-f0-9]{64}$/)
        expect(createArg.expiresAt).toBeInstanceOf(Date)

        expect(emailServiceMock.send).toHaveBeenCalledWith(
            expect.objectContaining({
                to: 'jane@example.com',
                subject: 'Reset your password',
            }),
        )
    })

    it('rejects expired reset tokens', async () => {
        passwordResetRepositoryMock.findByTokenHash.mockResolvedValue({
            id: 11n,
            userId: 7n,
            tokenHash: 'hash',
            expiresAt: new Date(Date.now() - 1000),
            usedAt: null,
            createdAt: new Date(),
        })
        passwordResetRepositoryMock.markUsed.mockResolvedValue({
            id: 11n,
        })

        const { passwordResetService } = await loadPasswordResetService()
        const result = await passwordResetService.resetPassword(
            'expired-token',
            'new-password',
            'new-password',
            { ipAddress: '127.0.0.1' },
        )

        expect(Result.isError(result)).toBe(true)
        if (Result.isError(result)) {
            expect(result.error).toEqual({
                _tag: 'BadRequest',
                reason: 'expired_token',
                message: 'Password reset link has expired',
            })
        }
        expect(passwordResetRepositoryMock.markUsed).toHaveBeenCalledWith(11n)
    })

    it('rejects already used reset tokens', async () => {
        passwordResetRepositoryMock.findByTokenHash.mockResolvedValue({
            id: 11n,
            userId: 7n,
            tokenHash: 'hash',
            expiresAt: new Date(Date.now() + 60_000),
            usedAt: new Date(),
            createdAt: new Date(),
        })

        const { passwordResetService } = await loadPasswordResetService()
        const result = await passwordResetService.resetPassword(
            'used-token',
            'new-password',
            'new-password',
            { ipAddress: '127.0.0.1' },
        )

        expect(Result.isError(result)).toBe(true)
        if (Result.isError(result)) {
            expect(result.error).toEqual({
                _tag: 'BadRequest',
                reason: 'used_token',
                message: 'Password reset link has already been used',
            })
        }
        expect(userRepositoryMock.findById).not.toHaveBeenCalled()
    })

    it('rejects mismatched passwords', async () => {
        const { passwordResetService } = await loadPasswordResetService()
        const result = await passwordResetService.resetPassword(
            'valid-token',
            'new-password',
            'different-password',
            { ipAddress: '127.0.0.1' },
        )

        expect(Result.isError(result)).toBe(true)
        if (Result.isError(result)) {
            expect(result.error).toEqual({
                _tag: 'BadRequest',
                reason: 'passwords_mismatch',
                message: 'Passwords do not match',
            })
        }
        expect(passwordResetRepositoryMock.findByTokenHash).not.toHaveBeenCalled()
    })

    it('updates password, rotates session token, and clears redis sessions', async () => {
        passwordResetRepositoryMock.findByTokenHash.mockResolvedValue({
            id: 11n,
            userId: 7n,
            tokenHash: 'hash',
            expiresAt: new Date(Date.now() + 60_000),
            usedAt: null,
            createdAt: new Date(),
        })
        userRepositoryMock.findById.mockResolvedValue({
            id: 7n,
            phone: '+14155550123',
            sessionToken: 'old-session-token',
        })
        hashPasswordMock.mockResolvedValue('hashed-password')
        destroyAllSessionsMock.mockResolvedValue(2)
        userRepositoryMock.update.mockResolvedValue({
            id: 7n,
            password: 'hashed-password',
            sessionToken: 'new-session-token',
        })
        passwordResetRepositoryMock.markUsed.mockResolvedValue({
            id: 11n,
            userId: 7n,
            usedAt: new Date(),
        })

        const { passwordResetService } = await loadPasswordResetService()
        const result = await passwordResetService.resetPassword(
            'valid-token',
            'new-password',
            'new-password',
            { ipAddress: '127.0.0.1' },
        )

        expect(hashPasswordMock).toHaveBeenCalledWith('new-password')
        expect(destroyAllSessionsMock).toHaveBeenCalledWith('old-session-token')
        expect(smsAuthChallengeRepositoryMock.invalidatePendingForPhoneFlow).toHaveBeenCalledWith(
            '+14155550123',
            'reset_phone',
        )
        expect(smsAuthChallengeRepositoryMock.invalidatePendingForPhoneFlow).toHaveBeenCalledWith(
            '+14155550123',
            'link_phone',
        )
        expect(userRepositoryMock.update).toHaveBeenCalledWith(7n, {
            password: 'hashed-password',
            sessionToken: 'new-session-token',
        })
        expect(passwordResetRepositoryMock.markUsed).toHaveBeenCalledWith(11n)
        expect(Result.isOk(result)).toBe(true)
        if (Result.isOk(result)) {
            expect(result.value).toEqual({ status: 'success' })
        }
    })

    it('starts a phone-only password reset challenge', async () => {
        consumeAuthThrottleMock.mockResolvedValue({ allowed: true, count: 1 })
        userRepositoryMock.findByPhone.mockResolvedValue({
            id: 8n,
            email: null,
            phone: '+14155550123',
        })
        smsAuthChallengeRepositoryMock.findLatestPendingForPhoneFlow.mockResolvedValue(undefined)
        smsAuthChallengeRepositoryMock.invalidatePendingForPhoneFlow.mockResolvedValue(0)
        smsAuthChallengeRepositoryMock.create.mockResolvedValue({
            id: 'reset-challenge-1',
            flow: 'reset_phone',
            phone: '+14155550123',
            codeHash: PENDING_SMS_CODE_HASH_PLACEHOLDER,
            providerRequestId: null,
            metadata: {
                userId: '8',
                ipAddress: '127.0.0.1',
                provider: 'fake',
                sessionId: 'session-id',
            },
            attemptCount: 0,
            sendCount: 1,
            resendAvailableAt: new Date('2099-05-15T10:01:00.000Z'),
            expiresAt: new Date('2099-05-15T10:10:00.000Z'),
            confirmedAt: null,
            invalidatedAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
        })
        issueVerificationCodeMock.mockResolvedValue({
            code: '123456',
            providerRequestId: 'fake-1',
        })
        smsAuthChallengeRepositoryMock.markIssued.mockResolvedValue({
            id: 'reset-challenge-1',
            flow: 'reset_phone',
            phone: '+14155550123',
            codeHash: 'hashed-code',
            providerRequestId: 'fake-1',
            metadata: {
                userId: '8',
                ipAddress: '127.0.0.1',
                provider: 'fake',
                sessionId: 'session-id',
            },
            attemptCount: 0,
            sendCount: 1,
            resendAvailableAt: new Date('2099-05-15T10:01:00.000Z'),
            expiresAt: new Date('2099-05-15T10:10:00.000Z'),
            confirmedAt: null,
            invalidatedAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
        })

        const { passwordResetService } = await loadPasswordResetService()
        const result = await passwordResetService.startPhonePasswordReset('+1 415 555 0123', 'US', {
            ipAddress: '127.0.0.1',
            sessionId: 'session-id',
        })

        expect(Result.isOk(result)).toBe(true)
        if (Result.isOk(result)) {
            expect(result.value.challengeId).toBe('reset-challenge-1')
        }
        expect(issueVerificationCodeMock).toHaveBeenCalledWith({
            phone: '+14155550123',
            flow: 'reset_phone',
        })
    })

    it('fails phone reset start when challenge expires before markIssued', async () => {
        consumeAuthThrottleMock.mockResolvedValue({ allowed: true, count: 1 })
        userRepositoryMock.findByPhone.mockResolvedValue({
            id: 8n,
            email: null,
            phone: '+14155550123',
        })
        smsAuthChallengeRepositoryMock.findLatestPendingForPhoneFlow.mockResolvedValue(undefined)
        smsAuthChallengeRepositoryMock.invalidatePendingForPhoneFlow.mockResolvedValue(0)
        smsAuthChallengeRepositoryMock.create.mockResolvedValue({
            id: 'reset-challenge-1',
            flow: 'reset_phone',
            phone: '+14155550123',
            codeHash: PENDING_SMS_CODE_HASH_PLACEHOLDER,
            providerRequestId: null,
            metadata: { userId: '8', ipAddress: '127.0.0.1', provider: 'fake' },
            attemptCount: 0,
            sendCount: 1,
            resendAvailableAt: new Date('2099-05-15T10:01:00.000Z'),
            expiresAt: new Date('2099-05-15T10:10:00.000Z'),
            confirmedAt: null,
            invalidatedAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
        })
        issueVerificationCodeMock.mockResolvedValue({
            code: '123456',
            providerRequestId: 'fake-1',
        })
        smsAuthChallengeRepositoryMock.markIssued.mockResolvedValue(undefined)
        smsAuthChallengeRepositoryMock.markInvalidated.mockResolvedValue({
            id: 'reset-challenge-1',
        })

        const { passwordResetService } = await loadPasswordResetService()
        const result = await passwordResetService.startPhonePasswordReset('+1 415 555 0123', 'US', {
            ipAddress: '127.0.0.1',
            sessionId: 'session-id',
        })

        expect(Result.isError(result)).toBe(true)
        expect(smsAuthChallengeRepositoryMock.markInvalidated).toHaveBeenCalledWith(
            'reset-challenge-1',
        )
    })

    // ADR 0002: the rotated sessionToken is the revocation, the Redis cleanup is only
    // memory. A failed cleanup must not stop the reset: the token would stay unused
    // after the password has already changed.
    it('still marks the token used when the Redis cleanup fails', async () => {
        passwordResetRepositoryMock.findByTokenHash.mockResolvedValue({
            id: 11n,
            userId: 7n,
            tokenHash: 'hash',
            expiresAt: new Date(Date.now() + 60_000),
            usedAt: null,
            createdAt: new Date(),
        })
        userRepositoryMock.findById.mockResolvedValue({
            id: 7n,
            phone: null,
            sessionToken: 'old-session-token',
        })
        hashPasswordMock.mockResolvedValue('hashed-password')
        destroyAllSessionsMock.mockRejectedValue(new Error('redis down'))
        userRepositoryMock.update.mockResolvedValue({
            id: 7n,
            password: 'hashed-password',
            sessionToken: 'new-session-token',
        })
        passwordResetRepositoryMock.markUsed.mockResolvedValue({
            id: 11n,
            userId: 7n,
            usedAt: new Date(),
        })

        const { passwordResetService } = await loadPasswordResetService()
        const result = await passwordResetService.resetPassword(
            'valid-token',
            'new-password',
            'new-password',
            { ipAddress: '127.0.0.1' },
        )

        expect(Result.isOk(result)).toBe(true)
        expect(userRepositoryMock.update).toHaveBeenCalledWith(7n, {
            password: 'hashed-password',
            sessionToken: 'new-session-token',
        })
        expect(destroyAllSessionsMock).toHaveBeenCalledWith('old-session-token')
        expect(passwordResetRepositoryMock.markUsed).toHaveBeenCalledWith(11n)
    })

    it('completes phone-only password reset and revokes all sessions', async () => {
        smsAuthChallengeRepositoryMock.findById.mockResolvedValue({
            id: 'reset-challenge-1',
            flow: 'reset_phone',
            phone: '+14155550123',
            codeHash: hashOtp('123456'),
            providerRequestId: 'fake-1',
            metadata: { userId: '8', ipAddress: '127.0.0.1', provider: 'fake' },
            attemptCount: 0,
            sendCount: 1,
            resendAvailableAt: new Date('2099-05-15T10:01:00.000Z'),
            expiresAt: new Date(Date.now() + 60_000),
            confirmedAt: null,
            invalidatedAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
        })
        userRepositoryMock.findById.mockResolvedValue({
            id: 8n,
            email: null,
            phone: '+14155550123',
            sessionToken: 'old-session-token',
        })
        hashPasswordMock.mockResolvedValue('hashed-password')
        userRepositoryMock.update.mockResolvedValue({
            id: 8n,
            password: 'hashed-password',
            sessionToken: 'new-session-token',
        })
        destroyAllSessionsMock.mockResolvedValue(3)
        smsAuthChallengeRepositoryMock.markConfirmed.mockResolvedValue({
            id: 'reset-challenge-1',
            confirmedAt: new Date(),
        })

        consumeAuthThrottleMock.mockResolvedValue({ allowed: true, count: 1 })

        const { passwordResetService } = await loadPasswordResetService()
        const result = await passwordResetService.completePhonePasswordReset(
            'reset-challenge-1',
            '123456',
            'new-password',
            'new-password',
            { ipAddress: '127.0.0.1' },
        )

        expect(Result.isOk(result)).toBe(true)
        expect(destroyAllSessionsMock).toHaveBeenCalledWith('old-session-token')
        expect(smsAuthChallengeRepositoryMock.invalidatePendingForPhoneFlow).toHaveBeenCalledWith(
            '+14155550123',
            'reset_phone',
        )
        expect(smsAuthChallengeRepositoryMock.invalidatePendingForPhoneFlow).toHaveBeenCalledWith(
            '+14155550123',
            'link_phone',
        )
        expect(userRepositoryMock.update).toHaveBeenCalledWith(8n, {
            password: 'hashed-password',
            sessionToken: 'new-session-token',
        })
    })

    it('completes the phone reset when the Redis cleanup fails', async () => {
        smsAuthChallengeRepositoryMock.findById.mockResolvedValue({
            id: 'reset-challenge-1',
            flow: 'reset_phone',
            phone: '+14155550123',
            codeHash: hashOtp('123456'),
            providerRequestId: 'fake-1',
            metadata: { userId: '8', ipAddress: '127.0.0.1', provider: 'fake' },
            attemptCount: 0,
            sendCount: 1,
            resendAvailableAt: new Date('2099-05-15T10:01:00.000Z'),
            expiresAt: new Date(Date.now() + 60_000),
            confirmedAt: null,
            invalidatedAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
        })
        userRepositoryMock.findById.mockResolvedValue({
            id: 8n,
            email: null,
            phone: '+14155550123',
            sessionToken: 'old-session-token',
        })
        hashPasswordMock.mockResolvedValue('hashed-password')
        userRepositoryMock.update.mockResolvedValue({
            id: 8n,
            password: 'hashed-password',
            sessionToken: 'new-session-token',
        })
        destroyAllSessionsMock.mockRejectedValue(new Error('redis down'))
        smsAuthChallengeRepositoryMock.markConfirmed.mockResolvedValue({
            id: 'reset-challenge-1',
            confirmedAt: new Date(),
        })
        consumeAuthThrottleMock.mockResolvedValue({ allowed: true, count: 1 })

        const { passwordResetService } = await loadPasswordResetService()
        const result = await passwordResetService.completePhonePasswordReset(
            'reset-challenge-1',
            '123456',
            'new-password',
            'new-password',
            { ipAddress: '127.0.0.1' },
        )

        expect(Result.isOk(result)).toBe(true)
        expect(destroyAllSessionsMock).toHaveBeenCalledWith('old-session-token')
        expect(userRepositoryMock.update).toHaveBeenCalledWith(8n, {
            password: 'hashed-password',
            sessionToken: 'new-session-token',
        })
    })

    it('rejects phone reset completion if the account linked an email after challenge issuance', async () => {
        smsAuthChallengeRepositoryMock.findById.mockResolvedValue({
            id: 'reset-challenge-1',
            flow: 'reset_phone',
            phone: '+14155550123',
            codeHash: hashOtp('123456'),
            providerRequestId: 'fake-1',
            metadata: { userId: '8', ipAddress: '127.0.0.1', provider: 'fake' },
            attemptCount: 0,
            sendCount: 1,
            resendAvailableAt: new Date('2099-05-15T10:01:00.000Z'),
            expiresAt: new Date(Date.now() + 60_000),
            confirmedAt: null,
            invalidatedAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
        })
        userRepositoryMock.findById.mockResolvedValue({
            id: 8n,
            email: 'user@example.com',
            phone: '+14155550123',
            sessionToken: 'old-session-token',
        })
        hashPasswordMock.mockResolvedValue('hashed-password')
        userRepositoryMock.update.mockResolvedValue({
            id: 8n,
            password: 'hashed-password',
            sessionToken: 'new-session-token',
        })
        destroyAllSessionsMock.mockResolvedValue(3)
        smsAuthChallengeRepositoryMock.markConfirmed.mockResolvedValue({
            id: 'reset-challenge-1',
            confirmedAt: new Date(),
        })

        consumeAuthThrottleMock.mockResolvedValue({ allowed: true, count: 1 })

        const { passwordResetService } = await loadPasswordResetService()
        const result = await passwordResetService.completePhonePasswordReset(
            'reset-challenge-1',
            '123456',
            'new-password',
            'new-password',
            { ipAddress: '127.0.0.1' },
        )

        expect(Result.isError(result)).toBe(true)
        if (Result.isError(result)) {
            expect(result.error).toEqual({
                _tag: 'BadRequest',
                message: 'Phone reset challenge is invalid',
            })
        }
        expect(userRepositoryMock.update).not.toHaveBeenCalled()
    })

    it("rejects phone reset completion if the user's phone changed after challenge issuance", async () => {
        smsAuthChallengeRepositoryMock.findById.mockResolvedValue({
            id: 'reset-challenge-1',
            flow: 'reset_phone',
            phone: '+14155550123',
            codeHash: hashOtp('123456'),
            providerRequestId: 'fake-1',
            metadata: { userId: '8', ipAddress: '127.0.0.1', provider: 'fake' },
            attemptCount: 0,
            sendCount: 1,
            resendAvailableAt: new Date('2099-05-15T10:01:00.000Z'),
            expiresAt: new Date(Date.now() + 60_000),
            confirmedAt: null,
            invalidatedAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
        })
        userRepositoryMock.findById.mockResolvedValue({
            id: 8n,
            email: null,
            phone: '+14155550999',
            sessionToken: 'old-session-token',
        })
        consumeAuthThrottleMock.mockResolvedValue({ allowed: true, count: 1 })

        const { passwordResetService } = await loadPasswordResetService()
        const result = await passwordResetService.completePhonePasswordReset(
            'reset-challenge-1',
            '123456',
            'new-password',
            'new-password',
            { ipAddress: '127.0.0.1' },
        )

        expect(Result.isError(result)).toBe(true)
        if (Result.isError(result)) {
            expect(result.error).toEqual({
                _tag: 'BadRequest',
                message: 'Phone reset challenge is invalid',
            })
        }
        expect(userRepositoryMock.update).not.toHaveBeenCalled()
    })

    it('returns invalid verification code when a reset challenge has no user binding', async () => {
        smsAuthChallengeRepositoryMock.findById.mockResolvedValue({
            id: 'reset-challenge-1',
            flow: 'reset_phone',
            phone: '+14155550123',
            codeHash: hashOtp('123456'),
            providerRequestId: 'fake-1',
            metadata: { blind: true, ipAddress: '127.0.0.1', provider: 'fake' },
            attemptCount: 0,
            sendCount: 1,
            resendAvailableAt: new Date('2099-05-15T10:01:00.000Z'),
            expiresAt: new Date(Date.now() + 60_000),
            confirmedAt: null,
            invalidatedAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
        })
        consumeAuthThrottleMock.mockResolvedValue({ allowed: true, count: 1 })

        const { passwordResetService } = await loadPasswordResetService()
        const result = await passwordResetService.completePhonePasswordReset(
            'reset-challenge-1',
            '123456',
            'new-password',
            'new-password',
            { ipAddress: '127.0.0.1' },
        )

        expect(Result.isError(result)).toBe(true)
        if (Result.isError(result)) {
            expect(result.error).toEqual({
                _tag: 'BadRequest',
                message: 'Invalid verification code',
            })
        }
        expect(userRepositoryMock.findById).not.toHaveBeenCalled()
    })
})

it('returns a generic challenge response for phone reset when the account is not eligible', async () => {
    consumeAuthThrottleMock.mockResolvedValue({ allowed: true, count: 1 })
    userRepositoryMock.findByPhone.mockResolvedValue({
        id: 9n,
        email: 'user@example.com',
        phone: '+14155550123',
    })
    smsAuthChallengeRepositoryMock.findLatestPendingForPhoneFlow.mockResolvedValue(undefined)
    smsAuthChallengeRepositoryMock.invalidatePendingForPhoneFlow.mockResolvedValue(0)
    smsAuthChallengeRepositoryMock.create.mockResolvedValue({
        id: 'blind-reset-1',
        flow: 'reset_phone',
        phone: '+14155550123',
        codeHash: 'blind-hash',
        providerRequestId: null,
        metadata: {
            blind: true,
            ipAddress: '127.0.0.1',
            provider: 'fake',
            sessionId: 'session-id',
        },
        attemptCount: 0,
        sendCount: 1,
        resendAvailableAt: new Date('2099-05-15T10:01:00.000Z'),
        expiresAt: new Date('2099-05-15T10:10:00.000Z'),
        confirmedAt: null,
        invalidatedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
    })

    const { passwordResetService } = await loadPasswordResetService()
    const result = await passwordResetService.startPhonePasswordReset('+1 415 555 0123', 'US', {
        ipAddress: '127.0.0.1',
        sessionId: 'session-id',
    })

    expect(Result.isOk(result)).toBe(true)
    if (Result.isOk(result)) {
        expect(result.value).toEqual({
            message:
                'If the phone number can be used for password reset, verification instructions will be sent shortly.',
            challengeId: 'blind-reset-1',
            expiresAt: '2099-05-15T10:10:00.000Z',
            resendAvailableAt: '2099-05-15T10:01:00.000Z',
        })
    }
    expect(issueVerificationCodeMock).not.toHaveBeenCalled()
})

it('enforces resend cooldown for phone reset on the server', async () => {
    consumeAuthThrottleMock.mockResolvedValue({ allowed: true, count: 1 })
    userRepositoryMock.findByPhone.mockResolvedValue({
        id: 8n,
        email: null,
        phone: '+14155550123',
    })
    smsAuthChallengeRepositoryMock.findLatestPendingForPhoneFlow.mockResolvedValue({
        id: 'reset-challenge-pending',
        flow: 'reset_phone',
        phone: '+14155550123',
        codeHash: 'hashed-code',
        providerRequestId: 'fake-reset-1',
        metadata: { userId: '8' },
        attemptCount: 0,
        sendCount: 1,
        resendAvailableAt: new Date(Date.now() + 45_000),
        expiresAt: new Date(Date.now() + 10 * 60_000),
        confirmedAt: null,
        invalidatedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
    })

    const { passwordResetService } = await loadPasswordResetService()
    const result = await passwordResetService.startPhonePasswordReset('+1 415 555 0123', 'US', {
        ipAddress: '127.0.0.1',
        sessionId: 'session-id',
    })

    expect(Result.isError(result)).toBe(true)
    if (Result.isError(result)) {
        expect(result.error._tag).toBe('RateLimited')
    }
    expect(smsAuthChallengeRepositoryMock.invalidatePendingForPhoneFlow).not.toHaveBeenCalled()
    expect(issueVerificationCodeMock).not.toHaveBeenCalled()
})

it('reuses an active phone reset challenge instead of invalidating it after cooldown', async () => {
    consumeAuthThrottleMock.mockResolvedValue({ allowed: true, count: 1 })
    userRepositoryMock.findByPhone.mockResolvedValue({
        id: 8n,
        email: null,
        phone: '+14155550123',
    })
    smsAuthChallengeRepositoryMock.findLatestPendingForPhoneFlow.mockResolvedValue({
        id: 'reset-challenge-existing',
        flow: 'reset_phone',
        phone: '+14155550123',
        codeHash: 'hashed-code',
        providerRequestId: 'fake-reset-1',
        metadata: { userId: '8', sessionId: 'session-id' },
        attemptCount: 0,
        sendCount: 1,
        resendAvailableAt: new Date(Date.now() - 1_000),
        expiresAt: new Date(Date.now() + 10 * 60_000),
        confirmedAt: null,
        invalidatedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
    })

    const { passwordResetService } = await loadPasswordResetService()
    const result = await passwordResetService.startPhonePasswordReset('+1 415 555 0123', 'US', {
        ipAddress: '127.0.0.1',
        sessionId: 'session-id',
    })

    expect(Result.isOk(result)).toBe(true)
    if (Result.isOk(result)) {
        expect(result.value.challengeId).toBe('reset-challenge-existing')
    }
    expect(smsAuthChallengeRepositoryMock.invalidatePendingForPhoneFlow).not.toHaveBeenCalled()
    expect(smsAuthChallengeRepositoryMock.create).not.toHaveBeenCalled()
    expect(issueVerificationCodeMock).not.toHaveBeenCalled()
})

it('does not reveal an existing pending reset challenge to a different session', async () => {
    consumeAuthThrottleMock.mockResolvedValue({ allowed: true, count: 1 })
    userRepositoryMock.findByPhone.mockResolvedValue({
        id: 8n,
        email: null,
        phone: '+14155550123',
    })
    smsAuthChallengeRepositoryMock.findLatestPendingForPhoneFlow.mockResolvedValue({
        id: 'reset-challenge-existing',
        flow: 'reset_phone',
        phone: '+14155550123',
        codeHash: 'hashed-code',
        providerRequestId: 'fake-reset-1',
        metadata: { userId: '8', sessionId: 'owner-session' },
        attemptCount: 0,
        sendCount: 1,
        resendAvailableAt: new Date(Date.now() - 1_000),
        expiresAt: new Date(Date.now() + 10 * 60_000),
        confirmedAt: null,
        invalidatedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
    })

    const { passwordResetService } = await loadPasswordResetService()
    const result = await passwordResetService.startPhonePasswordReset('+1 415 555 0123', 'US', {
        ipAddress: '127.0.0.1',
        sessionId: 'attacker-session',
    })

    expect(Result.isOk(result)).toBe(true)
    if (Result.isOk(result)) {
        expect(result.value).toEqual({
            message:
                'If the phone number can be used for password reset, verification instructions will be sent shortly.',
        })
    }
    expect(smsAuthChallengeRepositoryMock.invalidatePendingForPhoneFlow).not.toHaveBeenCalled()
    expect(smsAuthChallengeRepositoryMock.create).not.toHaveBeenCalled()
    expect(issueVerificationCodeMock).not.toHaveBeenCalled()
})

describe('auth throttle fail-closed (phone reset)', () => {
    const redisDown = (): void => {
        consumeAuthThrottleMock.mockReset()
        consumeAuthThrottleMock.mockRejectedValue(new Error('redis down'))
    }

    it('rejects phone reset start without issuing a code', async () => {
        redisDown()
        const { passwordResetService } = await loadPasswordResetService()
        const result = await passwordResetService.startPhonePasswordReset('+1 415 555 0123', 'US', {
            ipAddress: '127.0.0.1',
            sessionId: 'session-id',
        })
        expect(Result.isError(result)).toBe(true)
        expect(consumeAuthThrottleMock).toHaveBeenCalledTimes(1)
        expect(smsAuthChallengeRepositoryMock.create).not.toHaveBeenCalled()
        expect(issueVerificationCodeMock).not.toHaveBeenCalled()
    })

    it('rejects phone reset completion without loading the challenge', async () => {
        redisDown()
        const { passwordResetService } = await loadPasswordResetService()
        const result = await passwordResetService.completePhonePasswordReset(
            'reset-challenge-1',
            '123456',
            'new-password',
            'new-password',
            { ipAddress: '127.0.0.1' },
        )
        expect(Result.isError(result)).toBe(true)
        expect(consumeAuthThrottleMock).toHaveBeenCalledTimes(1)
        expect(smsAuthChallengeRepositoryMock.findById).not.toHaveBeenCalled()
    })
})

describe('forgot password and reset password throttles', () => {
    const GENERIC = { message: expect.any(String) as unknown }

    it('throttles by IP and email before looking up the address', async () => {
        userRepositoryMock.findByEmail.mockResolvedValue(undefined)
        const { passwordResetService } = await loadPasswordResetService()
        await passwordResetService.requestPasswordReset('User@Example.com', {
            ipAddress: '10.0.0.1',
        })
        const scopes = consumeAuthThrottleMock.mock.calls.map(
            (call) => (call[0] as { scope: string }).scope,
        )
        expect(scopes).toEqual(['forgot_password_ip', 'forgot_password_email'])
        expect(consumeAuthThrottleMock.mock.calls[1]?.[1]).toBe('user@example.com')
        expect(consumeAuthThrottleMock.mock.invocationCallOrder[1]).toBeLessThan(
            userRepositoryMock.findByEmail.mock.invocationCallOrder[0] ?? 0,
        )
    })

    it('answers the same for a known and an unknown address', async () => {
        const { passwordResetService } = await loadPasswordResetService()
        userRepositoryMock.findByEmail.mockResolvedValue(undefined)
        const unknown = await passwordResetService.requestPasswordReset('a@example.com', {
            ipAddress: '10.0.0.2',
        })
        userRepositoryMock.findByEmail.mockResolvedValue({ id: 1n, email: 'b@example.com' })
        const spy = vi
            .spyOn(passwordResetService, 'sendPasswordResetEmailInBackground')
            .mockResolvedValue(undefined)
        const known = await passwordResetService.requestPasswordReset('b@example.com', {
            ipAddress: '10.0.0.2',
        })
        expect(known).toEqual(unknown)
        spy.mockRestore()
    })

    it.each([
        [
            'the budget is spent',
            () => consumeAuthThrottleMock.mockResolvedValue({ allowed: false, count: 11 }),
        ],
        ['Redis fails', () => consumeAuthThrottleMock.mockRejectedValue(new Error('redis down'))],
    ])(
        'forgot password: no lookup and no email when %s, same generic answer',
        async (_n, arrange) => {
            arrange()
            const { passwordResetService } = await loadPasswordResetService()
            const spy = vi.spyOn(passwordResetService, 'sendPasswordResetEmailInBackground')
            const result = await passwordResetService.requestPasswordReset('user@example.com', {
                ipAddress: '10.0.0.3',
            })
            expect(Result.isOk(result) && result.value).toEqual(GENERIC)
            expect(userRepositoryMock.findByEmail).not.toHaveBeenCalled()
            expect(spy).not.toHaveBeenCalled()
            expect(emailServiceMock.send).not.toHaveBeenCalled()
            spy.mockRestore()
        },
    )

    it.each([
        [
            'the budget is spent',
            () => consumeAuthThrottleMock.mockResolvedValue({ allowed: false, count: 21 }),
        ],
        ['Redis fails', () => consumeAuthThrottleMock.mockRejectedValue(new Error('redis down'))],
    ])('reset password: rejected without checking the token when %s', async (_n, arrange) => {
        arrange()
        const { passwordResetService } = await loadPasswordResetService()
        const result = await passwordResetService.resetPassword(
            'some-token',
            'new-password',
            'new-password',
            { ipAddress: '10.0.0.4' },
        )
        expect(Result.isError(result)).toBe(true)
        expect(passwordResetRepositoryMock.findByTokenHash).not.toHaveBeenCalled()
        expect(consumeAuthThrottleMock).toHaveBeenCalledWith(
            expect.objectContaining({ scope: 'reset_password_ip' }),
            '10.0.0.4',
        )
    })
})
