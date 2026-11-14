import { Result } from 'better-result'
import { createHmac } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// feat-129: the session-still-stored guard is required; these cases keep the session.
const sessionStillStored = (): Promise<boolean> => Promise.resolve(true)

const userRepositoryMock = {
    findByEmail: vi.fn(),
    findByPhone: vi.fn(),
    findById: vi.fn(),
    phoneExistsForOtherUser: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateIfSessionToken: vi.fn(),
}

const smsAuthChallengeRepositoryMock = {
    invalidatePendingForPhoneFlow: vi.fn(),
    findLatestPendingForPhoneFlow: vi.fn(),
    lockPhoneFlow: vi.fn(() => Promise.resolve()),
    create: vi.fn(),
    markIssued: vi.fn(),
    findById: vi.fn(),
    consumeAttempt: vi.fn(),
    markInvalidatedIfPending: vi.fn(),
    markConfirmed: vi.fn(),
    markInvalidated: vi.fn(),
}

const authMock = {
    login: vi.fn(),
    logout: vi.fn(),
    logoutAll: vi.fn(() => Promise.resolve({ deleted: 0, complete: true })),
}

const sessionMock = {
    sessionInfo: {
        id: 'session-id',
        data: {},
    },
    destroySession: vi.fn(),
}

const loggerMock = {
    warn: vi.fn(),
    info: vi.fn(),
}

const hashPasswordMock = vi.fn()
const validatePasswordMock = vi.fn()
const generateWsTokenMock = vi.fn()
const consumeAuthThrottleMock = vi.fn()
const resetAuthThrottleMock = vi.fn()
const issueVerificationCodeMock = vi.fn()

vi.mock('#app/repositories/index.js', () => ({
    userRepository: userRepositoryMock,
    smsAuthChallengeRepository: smsAuthChallengeRepositoryMock,
    withTransaction: <T>(work: (tx: unknown) => Promise<T>): Promise<T> => work({}),
}))

vi.mock('#app/transformers/index.js', () => ({
    userTransformer: {
        serialize: vi.fn(
            (user: {
                id: bigint
                email: string | null
                phone?: string | null
                name?: string | null
            }) => ({
                id: String(user.id),
                email: user.email,
                phone: user.phone ?? null,
                name: user.name ?? '',
            }),
        ),
    },
}))

// The real module loads config/session, which needs metautil's duration().
vi.mock('#vendor/utils/session/redis-session-storage.js', () => ({
    destroyAllSessions: vi.fn(() => Promise.resolve({ deleted: 0, complete: true })),
}))

vi.mock('metautil', () => ({
    hashPassword: hashPasswordMock,
    validatePassword: validatePasswordMock,
}))

vi.mock('#app/services/auth/generate-ws-token-service.js', () => ({
    generateWsToken: generateWsTokenMock,
}))

vi.mock('#app/services/communication/get-ws-url-service.js', () => ({
    getWsUrl: vi.fn(() => 'wss://example.com/ws'),
}))

vi.mock('#app/services/auth/email-verification-service.js', () => ({
    emailVerificationService: {
        sendVerificationEmailAfterRegistration: vi.fn(),
        sendLinkVerificationEmail: vi.fn(),
    },
}))

vi.mock('#app/services/auth/auth-throttle-service.js', () => ({
    consumeAuthThrottle: consumeAuthThrottleMock,
    resetAuthThrottle: resetAuthThrottleMock,
}))

vi.mock('#app/services/auth/sms-verification-provider.js', () => ({
    smsVerificationProvider: {
        issueVerificationCode: issueVerificationCodeMock,
    },
    fakeSmsVerificationProvider: {
        reset: vi.fn(),
        latestForPhone: vi.fn(),
    },
}))

async function loadAuthService() {
    return import('./auth-service.js')
}

function hashOtp(code: string): string {
    return createHmac('sha256', 'a'.repeat(32)).update(code).digest('hex')
}

beforeEach(() => {
    // feat-103: every code check spends a try first; by default the try succeeds on the row
    // findById returns.
    smsAuthChallengeRepositoryMock.consumeAttempt.mockImplementation(async (id: string) => {
        const found = (await smsAuthChallengeRepositoryMock.findById(id)) as
            { attemptCount?: number } | undefined
        return found === undefined
            ? undefined
            : { ...found, attemptCount: (found.attemptCount ?? 0) + 1 }
    })
    consumeAuthThrottleMock.mockReset()
    consumeAuthThrottleMock.mockResolvedValue({ allowed: true, count: 1 })
    resetAuthThrottleMock.mockReset()
    resetAuthThrottleMock.mockResolvedValue(undefined)
    process.env['APP_KEY'] = 'a'.repeat(32)
    process.env['AUTH_PHONE_ENABLED'] = 'true'
    process.env['AUTH_SMS_PROVIDER'] = 'fake'
})

afterEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    sessionMock.sessionInfo = {
        id: 'session-id',
        data: {},
    }
    process.env['APP_KEY'] = 'a'.repeat(32)
    process.env['AUTH_PHONE_ENABLED'] = 'true'
    process.env['AUTH_SMS_PROVIDER'] = 'fake'
})

describe('authService phone foundation', () => {
    it('logs in with a phone identifier when phone auth is enabled', async () => {
        consumeAuthThrottleMock.mockResolvedValue({ allowed: true, count: 1 })
        userRepositoryMock.findByPhone.mockResolvedValue({
            id: 7n,
            email: null,
            phone: '+14155550123',
            name: 'Jane',
            password: 'hashed-password',
            sessionToken: 'session-token',
        })
        validatePasswordMock.mockResolvedValue(true)
        authMock.login.mockResolvedValue(true)
        generateWsTokenMock.mockResolvedValue('ws-token')

        const { authService } = await loadAuthService()
        const result = await authService.login(
            {
                identifier: '+1 415 555 0123',
                password: 'secret123',
            },
            authMock as any,
            sessionMock as any,
            { ipAddress: '127.0.0.1' },
        )

        expect(userRepositoryMock.findByPhone).toHaveBeenCalledWith('+14155550123')
        expect(validatePasswordMock).toHaveBeenCalledWith('secret123', 'hashed-password')
        expect(Result.isOk(result)).toBe(true)
    })

    it('checks an unknown phone against the dummy hash and answers like a wrong password', async () => {
        consumeAuthThrottleMock.mockResolvedValue({ allowed: true, count: 1 })
        userRepositoryMock.findByPhone.mockResolvedValue(undefined)
        hashPasswordMock.mockResolvedValue('dummy-hash')
        validatePasswordMock.mockResolvedValue(false)

        const { authService } = await loadAuthService()
        const result = await authService.login(
            {
                identifier: '+1 415 555 0123',
                password: 'secret123',
            },
            authMock as any,
            sessionMock as any,
            { ipAddress: '127.0.0.1' },
        )

        expect(userRepositoryMock.findByPhone).toHaveBeenCalledWith('+14155550123')
        expect(validatePasswordMock).toHaveBeenCalledTimes(1)
        expect(validatePasswordMock).toHaveBeenCalledWith('secret123', 'dummy-hash')
        expect(Result.isError(result)).toBe(true)
        if (Result.isError(result)) {
            expect(result.error).toEqual({
                _tag: 'Unauthorized',
                message: 'Invalid email or password',
            })
        }
        expect(authMock.login).not.toHaveBeenCalled()
    })

    it('starts phone registration without storing a pre-account password hash', async () => {
        consumeAuthThrottleMock.mockResolvedValue({ allowed: true, count: 1 })
        userRepositoryMock.findByPhone.mockResolvedValue(undefined)
        smsAuthChallengeRepositoryMock.findLatestPendingForPhoneFlow.mockResolvedValue(undefined)
        smsAuthChallengeRepositoryMock.invalidatePendingForPhoneFlow.mockResolvedValue(0)
        smsAuthChallengeRepositoryMock.create.mockResolvedValue({
            id: 'challenge-1',
            flow: 'register_phone',
            phone: '+14155550123',
            codeHash: 'PENDING_SMS_CODE_HASH_PLACEHOLDER',
            providerRequestId: null,
            metadata: {
                ipAddress: '127.0.0.1',
                provider: 'fake',
                sessionId: 'session-id',
            },
            attemptCount: 0,
            resendAvailableAt: new Date('2099-05-15T10:01:00.000Z'),
            expiresAt: new Date('2099-05-15T10:10:00.000Z'),
            confirmedAt: null,
            invalidatedAt: null,
            createdAt: new Date('2026-05-15T10:00:00.000Z'),
            updatedAt: new Date('2026-05-15T10:00:00.000Z'),
        })
        issueVerificationCodeMock.mockResolvedValue({
            code: '123456',
            providerRequestId: 'fake-1',
        })
        smsAuthChallengeRepositoryMock.markIssued.mockResolvedValue({
            id: 'challenge-1',
            flow: 'register_phone',
            phone: '+14155550123',
            codeHash: 'hashed-code',
            providerRequestId: 'fake-1',
            metadata: {
                ipAddress: '127.0.0.1',
                provider: 'fake',
                sessionId: 'session-id',
            },
            attemptCount: 0,
            resendAvailableAt: new Date('2099-05-15T10:01:00.000Z'),
            expiresAt: new Date('2099-05-15T10:10:00.000Z'),
            confirmedAt: null,
            invalidatedAt: null,
            createdAt: new Date('2026-05-15T10:00:00.000Z'),
            updatedAt: new Date('2026-05-15T10:00:01.000Z'),
        })

        const { authService } = await loadAuthService()
        const result = await authService.startPhoneRegistration(
            {
                phone: '+1 415 555 0123',
            },
            { ipAddress: '127.0.0.1', sessionId: 'session-id' },
        )

        expect(Result.isOk(result)).toBe(true)
        expect(smsAuthChallengeRepositoryMock.create).toHaveBeenCalledWith(
            expect.not.objectContaining({ password: expect.anything() }),
            expect.anything(),
        )
        expect(smsAuthChallengeRepositoryMock.create).toHaveBeenCalledWith(
            expect.objectContaining({
                flow: 'register_phone',
                phone: '+14155550123',
            }),
            expect.anything(),
        )
        const invalidateCallOrder =
            smsAuthChallengeRepositoryMock.invalidatePendingForPhoneFlow.mock.invocationCallOrder[0]
        const createCallOrder = smsAuthChallengeRepositoryMock.create.mock.invocationCallOrder[0]
        const issueCodeCallOrder = issueVerificationCodeMock.mock.invocationCallOrder[0]

        expect(invalidateCallOrder).toBeDefined()
        expect(createCallOrder).toBeDefined()
        expect(issueCodeCallOrder).toBeDefined()
        expect(invalidateCallOrder!).toBeLessThan(createCallOrder!)
        expect(createCallOrder!).toBeLessThan(issueCodeCallOrder!)
        expect(smsAuthChallengeRepositoryMock.markIssued).toHaveBeenCalledWith(
            'challenge-1',
            expect.objectContaining({
                providerRequestId: 'fake-1',
                metadata: {
                    ipAddress: '127.0.0.1',
                    provider: 'fake',
                    sessionId: 'session-id',
                },
            }),
        )
    })

    it('fails phone registration start when challenge expires before markIssued', async () => {
        consumeAuthThrottleMock.mockResolvedValue({ allowed: true, count: 1 })
        userRepositoryMock.findByPhone.mockResolvedValue(undefined)
        smsAuthChallengeRepositoryMock.findLatestPendingForPhoneFlow.mockResolvedValue(undefined)
        smsAuthChallengeRepositoryMock.invalidatePendingForPhoneFlow.mockResolvedValue(0)
        smsAuthChallengeRepositoryMock.create.mockResolvedValue({
            id: 'challenge-1',
            flow: 'register_phone',
            phone: '+14155550123',
            codeHash: 'PENDING_SMS_CODE_HASH_PLACEHOLDER',
            providerRequestId: null,
            metadata: {
                ipAddress: '127.0.0.1',
                provider: 'fake',
                sessionId: 'session-id',
            },
            attemptCount: 0,
            resendAvailableAt: new Date('2099-05-15T10:01:00.000Z'),
            expiresAt: new Date('2099-05-15T10:10:00.000Z'),
            confirmedAt: null,
            invalidatedAt: null,
            createdAt: new Date('2026-05-15T10:00:00.000Z'),
            updatedAt: new Date('2026-05-15T10:00:00.000Z'),
        })
        issueVerificationCodeMock.mockResolvedValue({
            code: '123456',
            providerRequestId: 'fake-1',
        })
        smsAuthChallengeRepositoryMock.markIssued.mockResolvedValue(undefined)
        smsAuthChallengeRepositoryMock.markInvalidated.mockResolvedValue({
            id: 'challenge-1',
        })

        const { authService } = await loadAuthService()
        const result = await authService.startPhoneRegistration(
            {
                phone: '+1 415 555 0123',
            },
            { ipAddress: '127.0.0.1', sessionId: 'session-id' },
        )

        expect(Result.isError(result)).toBe(true)
        expect(smsAuthChallengeRepositoryMock.markInvalidated).toHaveBeenCalledWith('challenge-1')
    })

    it('keeps phone registration start outwardly generic when the phone already exists', async () => {
        consumeAuthThrottleMock.mockResolvedValue({ allowed: true, count: 1 })
        userRepositoryMock.findByPhone.mockResolvedValue({
            id: 11n,
            email: null,
            phone: '+14155550123',
            name: 'Existing User',
            password: 'hashed-password',
            sessionToken: 'existing-session',
        })
        smsAuthChallengeRepositoryMock.findLatestPendingForPhoneFlow.mockResolvedValue(undefined)
        smsAuthChallengeRepositoryMock.invalidatePendingForPhoneFlow.mockResolvedValue(1)
        smsAuthChallengeRepositoryMock.create.mockResolvedValue({
            id: 'challenge-existing',
            flow: 'register_phone',
            phone: '+14155550123',
            codeHash: 'PENDING_SMS_CODE_HASH_PLACEHOLDER',
            providerRequestId: null,
            metadata: {
                ipAddress: '127.0.0.1',
                provider: 'fake',
                sessionId: 'session-id',
            },
            attemptCount: 0,
            resendAvailableAt: new Date('2099-05-15T10:01:00.000Z'),
            expiresAt: new Date('2099-05-15T10:10:00.000Z'),
            confirmedAt: null,
            invalidatedAt: null,
            createdAt: new Date('2026-05-15T10:00:00.000Z'),
            updatedAt: new Date('2026-05-15T10:00:00.000Z'),
        })
        issueVerificationCodeMock.mockResolvedValue({
            code: '123456',
            providerRequestId: 'fake-2',
        })
        smsAuthChallengeRepositoryMock.markIssued.mockResolvedValue({
            id: 'challenge-existing',
            flow: 'register_phone',
            phone: '+14155550123',
            codeHash: 'hashed-code',
            providerRequestId: 'fake-2',
            metadata: {
                ipAddress: '127.0.0.1',
                provider: 'fake',
                sessionId: 'session-id',
            },
            attemptCount: 0,
            resendAvailableAt: new Date('2099-05-15T10:01:00.000Z'),
            expiresAt: new Date('2099-05-15T10:10:00.000Z'),
            confirmedAt: null,
            invalidatedAt: null,
            createdAt: new Date('2026-05-15T10:00:00.000Z'),
            updatedAt: new Date('2026-05-15T10:00:01.000Z'),
        })

        const { authService } = await loadAuthService()
        const result = await authService.startPhoneRegistration(
            {
                phone: '+1 415 555 0123',
            },
            { ipAddress: '127.0.0.1', sessionId: 'session-id' },
        )

        expect(Result.isOk(result)).toBe(true)
        expect(issueVerificationCodeMock).toHaveBeenCalledWith({
            phone: '+14155550123',
            flow: 'register_phone',
        })
        expect(smsAuthChallengeRepositoryMock.markIssued).toHaveBeenCalledWith(
            'challenge-existing',
            expect.objectContaining({
                metadata: expect.objectContaining({
                    ipAddress: '127.0.0.1',
                    provider: 'fake',
                    sessionId: 'session-id',
                }),
            }),
        )
    })

    it('throttles phone registration confirmation attempts by IP address', async () => {
        consumeAuthThrottleMock.mockResolvedValue({ allowed: false, count: 21 })

        const { authService } = await loadAuthService()
        const result = await authService.confirmPhoneRegistration(
            {
                challengeId: 'challenge-1',
                code: '000000',
            },
            { ipAddress: '127.0.0.1' },
        )

        expect(Result.isError(result)).toBe(true)
        expect(smsAuthChallengeRepositoryMock.findById).not.toHaveBeenCalled()
        expect(consumeAuthThrottleMock).toHaveBeenCalledWith(
            expect.objectContaining({
                scope: 'confirm_phone_ip',
                limit: 20,
                windowMs: 60 * 60 * 1000,
            }),
            '127.0.0.1',
        )
    })

    it('invalidates a phone registration challenge after the fifth wrong code attempt', async () => {
        consumeAuthThrottleMock.mockResolvedValue({ allowed: true, count: 1 })
        smsAuthChallengeRepositoryMock.findById.mockResolvedValue({
            id: 'challenge-1',
            flow: 'register_phone',
            phone: '+14155550123',
            codeHash: 'hashed-code',
            providerRequestId: 'fake-1',
            metadata: { sessionId: 'session-id' },
            attemptCount: 4,
            resendAvailableAt: new Date('2099-05-15T10:01:00.000Z'),
            expiresAt: new Date('2099-05-15T10:10:00.000Z'),
            confirmedAt: null,
            invalidatedAt: null,
            createdAt: new Date('2026-05-15T10:00:00.000Z'),
            updatedAt: new Date('2026-05-15T10:00:00.000Z'),
        })
        smsAuthChallengeRepositoryMock.markInvalidated.mockResolvedValue({
            id: 'challenge-1',
        })

        const { authService } = await loadAuthService()
        const result = await authService.confirmPhoneRegistration(
            {
                challengeId: 'challenge-1',
                code: '000000',
            },
            { ipAddress: '127.0.0.1' },
        )

        expect(Result.isError(result)).toBe(true)
        expect(smsAuthChallengeRepositoryMock.consumeAttempt).toHaveBeenCalledWith(
            'challenge-1',
            5,
            undefined,
        )
        expect(smsAuthChallengeRepositoryMock.markInvalidatedIfPending).toHaveBeenCalledWith(
            'challenge-1',
            undefined,
        )
    })

    it('completes phone registration after confirmation and creates a phone-only user', async () => {
        smsAuthChallengeRepositoryMock.findById.mockResolvedValue({
            id: 'challenge-1',
            flow: 'register_phone',
            phone: '+14155550123',
            codeHash: 'hashed-code',
            providerRequestId: 'fake-1',
            metadata: { sessionId: 'session-id' },
            attemptCount: 0,
            resendAvailableAt: new Date('2099-05-15T10:01:00.000Z'),
            expiresAt: new Date('2099-05-15T10:10:00.000Z'),
            confirmedAt: new Date('2026-05-15T10:00:30.000Z'),
            invalidatedAt: null,
            createdAt: new Date('2026-05-15T10:00:00.000Z'),
            updatedAt: new Date('2026-05-15T10:00:30.000Z'),
        })
        userRepositoryMock.findByPhone.mockResolvedValue(undefined)
        hashPasswordMock.mockResolvedValue('hashed-password')
        userRepositoryMock.create.mockResolvedValue({
            id: 9n,
            email: null,
            phone: '+14155550123',
            name: 'Phone User',
            sessionToken: 'session-token',
        })
        smsAuthChallengeRepositoryMock.markInvalidated.mockResolvedValue({
            id: 'challenge-1',
        })
        sessionMock.destroySession.mockResolvedValue(undefined)
        authMock.login.mockResolvedValue(true)
        generateWsTokenMock.mockResolvedValue('ws-token')

        const { authService } = await loadAuthService()
        const result = await authService.completePhoneRegistration(
            {
                challengeId: 'challenge-1',
                name: 'Phone User',
                password: 'secret123',
            },
            authMock as any,
            sessionMock as any,
            loggerMock as any,
            { sessionId: 'session-id' },
        )

        expect(hashPasswordMock).toHaveBeenCalledWith('secret123')
        expect(userRepositoryMock.create).toHaveBeenCalledWith(
            expect.objectContaining({
                email: null,
                phone: '+14155550123',
                password: 'hashed-password',
            }),
        )
        expect(Result.isOk(result)).toBe(true)
    })

    it('rejects completePhoneRegistration when the challenge session does not match', async () => {
        smsAuthChallengeRepositoryMock.findById.mockResolvedValue({
            id: 'challenge-1',
            flow: 'register_phone',
            phone: '+14155550123',
            codeHash: 'hashed-code',
            providerRequestId: 'fake-1',
            metadata: { sessionId: 'another-session' },
            attemptCount: 0,
            resendAvailableAt: new Date('2099-05-15T10:01:00.000Z'),
            expiresAt: new Date('2099-05-15T10:10:00.000Z'),
            confirmedAt: new Date('2026-05-15T10:00:30.000Z'),
            invalidatedAt: null,
            createdAt: new Date('2026-05-15T10:00:00.000Z'),
            updatedAt: new Date('2026-05-15T10:00:30.000Z'),
        })

        const { authService } = await loadAuthService()
        const result = await authService.completePhoneRegistration(
            {
                challengeId: 'challenge-1',
                name: 'Phone User',
                password: 'secret123',
            },
            authMock as any,
            sessionMock as any,
            loggerMock as any,
            { sessionId: 'session-id' },
        )

        expect(Result.isError(result)).toBe(true)
        expect(userRepositoryMock.findByPhone).not.toHaveBeenCalled()
    })

    it('starts a phone linking challenge after re-authentication', async () => {
        userRepositoryMock.findById.mockResolvedValue({
            id: 7n,
            email: 'user@example.com',
            phone: null,
            password: 'hashed-password',
            sessionToken: 'session-token',
        })
        validatePasswordMock.mockResolvedValue(true)
        consumeAuthThrottleMock.mockResolvedValue({ allowed: true, count: 1 })
        userRepositoryMock.phoneExistsForOtherUser.mockResolvedValue(false)
        smsAuthChallengeRepositoryMock.findLatestPendingForPhoneFlow.mockResolvedValue(undefined)
        smsAuthChallengeRepositoryMock.invalidatePendingForPhoneFlow.mockResolvedValue(0)
        smsAuthChallengeRepositoryMock.create.mockResolvedValue({
            id: 'link-challenge-1',
            flow: 'link_phone',
            phone: '+14155550123',
            codeHash: 'PENDING_SMS_CODE_HASH_PLACEHOLDER',
            providerRequestId: null,
            metadata: {
                userId: '7',
                ipAddress: '127.0.0.1',
                provider: 'fake',
                sessionId: 'session-id',
            },
            attemptCount: 0,
            resendAvailableAt: new Date('2099-05-15T10:01:00.000Z'),
            expiresAt: new Date('2099-05-15T10:10:00.000Z'),
            confirmedAt: null,
            invalidatedAt: null,
            createdAt: new Date('2026-05-15T10:00:00.000Z'),
            updatedAt: new Date('2026-05-15T10:00:00.000Z'),
        })
        issueVerificationCodeMock.mockResolvedValue({
            code: '123456',
            providerRequestId: 'fake-link-1',
        })
        smsAuthChallengeRepositoryMock.markIssued.mockResolvedValue({
            id: 'link-challenge-1',
            flow: 'link_phone',
            phone: '+14155550123',
            codeHash: 'hashed-code',
            providerRequestId: 'fake-link-1',
            metadata: {
                userId: '7',
                ipAddress: '127.0.0.1',
                provider: 'fake',
                sessionId: 'session-id',
            },
            attemptCount: 0,
            resendAvailableAt: new Date('2099-05-15T10:01:00.000Z'),
            expiresAt: new Date('2099-05-15T10:10:00.000Z'),
            confirmedAt: null,
            invalidatedAt: null,
            createdAt: new Date('2026-05-15T10:00:00.000Z'),
            updatedAt: new Date('2026-05-15T10:00:01.000Z'),
        })

        const { authService } = await loadAuthService()
        const result = await authService.startPhoneLink(
            7n,
            {
                phone: '+1 415 555 0123',
                currentPassword: 'secret123',
            },
            {
                ipAddress: '127.0.0.1',
                sessionId: 'session-id',
                presentedSessionToken: 'session-token',
                sessionStored: sessionStillStored,
            },
        )

        expect(Result.isOk(result)).toBe(true)
        expect(userRepositoryMock.phoneExistsForOtherUser).toHaveBeenCalledWith('+14155550123', 7n)
        expect(issueVerificationCodeMock).toHaveBeenCalledWith({
            phone: '+14155550123',
            flow: 'link_phone',
        })
    })

    // feat-123 (L5): a logout in another tab deleted the record; asked right before the SMS.
    it('sends no SMS when the session record is gone by then: 401', async () => {
        userRepositoryMock.findById.mockResolvedValue({
            id: 7n,
            email: 'user@example.com',
            phone: null,
            password: 'hashed-password',
            sessionToken: 'session-token',
        })
        validatePasswordMock.mockResolvedValue(true)
        consumeAuthThrottleMock.mockResolvedValue({ allowed: true, count: 1 })
        userRepositoryMock.phoneExistsForOtherUser.mockResolvedValue(false)
        smsAuthChallengeRepositoryMock.findLatestPendingForPhoneFlow.mockResolvedValue(undefined)
        smsAuthChallengeRepositoryMock.invalidatePendingForPhoneFlow.mockResolvedValue(0)
        smsAuthChallengeRepositoryMock.create.mockResolvedValue({
            id: 'link-challenge-1',
            flow: 'link_phone',
            phone: '+14155550123',
            codeHash: 'PENDING_SMS_CODE_HASH_PLACEHOLDER',
            providerRequestId: null,
            metadata: {
                userId: '7',
                ipAddress: '127.0.0.1',
                provider: 'fake',
                sessionId: 'session-id',
            },
            attemptCount: 0,
            resendAvailableAt: new Date('2099-05-15T10:01:00.000Z'),
            expiresAt: new Date('2099-05-15T10:10:00.000Z'),
            confirmedAt: null,
            invalidatedAt: null,
            createdAt: new Date('2026-05-15T10:00:00.000Z'),
            updatedAt: new Date('2026-05-15T10:00:00.000Z'),
        })
        issueVerificationCodeMock.mockResolvedValue({
            code: '123456',
            providerRequestId: 'fake-link-1',
        })
        smsAuthChallengeRepositoryMock.markIssued.mockResolvedValue({
            id: 'link-challenge-1',
            flow: 'link_phone',
            phone: '+14155550123',
            codeHash: 'hashed-code',
            providerRequestId: 'fake-link-1',
            metadata: {
                userId: '7',
                ipAddress: '127.0.0.1',
                provider: 'fake',
                sessionId: 'session-id',
            },
            attemptCount: 0,
            resendAvailableAt: new Date('2099-05-15T10:01:00.000Z'),
            expiresAt: new Date('2099-05-15T10:10:00.000Z'),
            confirmedAt: null,
            invalidatedAt: null,
            createdAt: new Date('2026-05-15T10:00:00.000Z'),
            updatedAt: new Date('2026-05-15T10:00:01.000Z'),
        })

        const { authService } = await loadAuthService()
        const result = await authService.startPhoneLink(
            7n,
            {
                phone: '+1 415 555 0123',
                currentPassword: 'secret123',
            },
            {
                ipAddress: '127.0.0.1',
                sessionId: 'session-id',
                presentedSessionToken: 'session-token',
                sessionStored: () => Promise.resolve(false),
            },
        )

        expect(Result.isError(result) && result.error).toMatchObject({
            _tag: 'Unauthorized',
            reason: 'session_revoked',
        })
        expect(issueVerificationCodeMock).not.toHaveBeenCalled()
        expect(smsAuthChallengeRepositoryMock.create).not.toHaveBeenCalled()
    })

    it('requires an active session to start phone linking', async () => {
        const { authService } = await loadAuthService()
        const result = await authService.startPhoneLink(
            7n,
            {
                phone: '+1 415 555 0123',
                currentPassword: 'secret123',
            },
            {
                ipAddress: '127.0.0.1',
                sessionId: null,
                presentedSessionToken: 'session-token',
                sessionStored: sessionStillStored,
            },
        )

        expect(Result.isError(result)).toBe(true)
        if (Result.isError(result)) {
            expect(result.error).toEqual({
                _tag: 'BadRequest',
                message: 'Phone linking requires an active session',
            })
        }
        expect(userRepositoryMock.findById).not.toHaveBeenCalled()
    })

    it('enforces resend cooldown for phone registration on the server', async () => {
        consumeAuthThrottleMock.mockResolvedValue({ allowed: true, count: 1 })
        userRepositoryMock.findByPhone.mockResolvedValue(undefined)
        smsAuthChallengeRepositoryMock.findLatestPendingForPhoneFlow.mockResolvedValue({
            id: 'challenge-pending',
            flow: 'register_phone',
            phone: '+14155550123',
            codeHash: 'hashed-code',
            providerRequestId: 'fake-1',
            metadata: { sessionId: 'session-id' },
            attemptCount: 0,
            resendAvailableAt: new Date(Date.now() + 45_000),
            expiresAt: new Date(Date.now() + 10 * 60_000),
            confirmedAt: null,
            invalidatedAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
        })

        const { authService } = await loadAuthService()
        const result = await authService.startPhoneRegistration(
            {
                phone: '+1 415 555 0123',
            },
            { ipAddress: '127.0.0.1', sessionId: 'session-id' },
        )

        expect(Result.isError(result)).toBe(true)
        if (Result.isError(result)) {
            expect(result.error._tag).toBe('RateLimited')
        }
        expect(smsAuthChallengeRepositoryMock.invalidatePendingForPhoneFlow).not.toHaveBeenCalled()
        expect(issueVerificationCodeMock).not.toHaveBeenCalled()
    })

    it('throttles phone linking confirmation attempts by IP address', async () => {
        consumeAuthThrottleMock.mockResolvedValue({ allowed: false, count: 21 })

        const { authService } = await loadAuthService()
        const result = await authService.confirmPhoneLink(
            7n,
            {
                challengeId: 'link-challenge-1',
                code: '123456',
            },
            {
                ipAddress: '127.0.0.1',
                sessionId: 'session-id',
                presentedSessionToken: 'session-token',
                sessionStored: sessionStillStored,
            },
        )

        expect(Result.isError(result)).toBe(true)
        expect(smsAuthChallengeRepositoryMock.findById).not.toHaveBeenCalled()
        expect(consumeAuthThrottleMock).toHaveBeenCalledWith(
            expect.objectContaining({
                scope: 'confirm_link_phone_ip',
                limit: 20,
                windowMs: 60 * 60 * 1000,
            }),
            '127.0.0.1',
        )
    })

    it('confirms a linked phone and updates the user account', async () => {
        smsAuthChallengeRepositoryMock.findById.mockResolvedValue({
            id: 'link-challenge-1',
            flow: 'link_phone',
            phone: '+14155550123',
            codeHash: hashOtp('123456'),
            providerRequestId: 'fake-link-1',
            metadata: {
                userId: '7',
                ipAddress: '127.0.0.1',
                provider: 'fake',
                sessionId: 'session-id',
            },
            attemptCount: 0,
            resendAvailableAt: new Date('2099-05-15T10:01:00.000Z'),
            expiresAt: new Date('2099-05-15T10:10:00.000Z'),
            confirmedAt: null,
            invalidatedAt: null,
            createdAt: new Date('2026-05-15T10:00:00.000Z'),
            updatedAt: new Date('2026-05-15T10:00:01.000Z'),
        })
        userRepositoryMock.findById.mockResolvedValue({
            id: 7n,
            email: 'user@example.com',
            phone: null,
            name: 'Jane',
            password: 'hashed-password',
            sessionToken: 'session-token',
        })
        userRepositoryMock.phoneExistsForOtherUser.mockResolvedValue(false)
        smsAuthChallengeRepositoryMock.markConfirmed.mockResolvedValue({
            id: 'link-challenge-1',
            confirmedAt: new Date(),
        })
        userRepositoryMock.updateIfSessionToken.mockResolvedValue({
            id: 7n,
            email: 'user@example.com',
            phone: '+14155550123',
            name: 'Jane',
            password: 'hashed-password',
            sessionToken: 'session-token',
            createdAt: new Date('2026-05-15T10:00:00.000Z'),
            updatedAt: new Date('2026-05-15T10:01:00.000Z'),
            emailVerifiedAt: null,
            avatar: null,
            role: 'user',
        })

        const { authService } = await loadAuthService()
        consumeAuthThrottleMock.mockResolvedValue({ allowed: true, count: 1 })

        const result = await authService.confirmPhoneLink(
            7n,
            {
                challengeId: 'link-challenge-1',
                code: '123456',
            },
            {
                ipAddress: '127.0.0.1',
                sessionId: 'session-id',
                presentedSessionToken: 'session-token',
                sessionStored: sessionStillStored,
            },
        )

        expect(Result.isOk(result)).toBe(true)
        expect(userRepositoryMock.updateIfSessionToken).toHaveBeenCalledWith(7n, 'session-token', {
            phone: '+14155550123',
        })
        expect(userRepositoryMock.update).not.toHaveBeenCalled()
    })

    it('rejects phone link confirmation when the challenge session does not match', async () => {
        consumeAuthThrottleMock.mockResolvedValue({ allowed: true, count: 1 })
        smsAuthChallengeRepositoryMock.findById.mockResolvedValue({
            id: 'link-challenge-1',
            flow: 'link_phone',
            phone: '+14155550123',
            codeHash: hashOtp('123456'),
            providerRequestId: 'fake-link-1',
            metadata: {
                userId: '7',
                ipAddress: '127.0.0.1',
                provider: 'fake',
                sessionId: 'other-session',
            },
            attemptCount: 0,
            resendAvailableAt: new Date('2099-05-15T10:01:00.000Z'),
            expiresAt: new Date('2099-05-15T10:10:00.000Z'),
            confirmedAt: null,
            invalidatedAt: null,
            createdAt: new Date('2026-05-15T10:00:00.000Z'),
            updatedAt: new Date('2026-05-15T10:00:01.000Z'),
        })

        const { authService } = await loadAuthService()
        const result = await authService.confirmPhoneLink(
            7n,
            {
                challengeId: 'link-challenge-1',
                code: '123456',
            },
            {
                ipAddress: '127.0.0.1',
                sessionId: 'session-id',
                presentedSessionToken: 'session-token',
                sessionStored: sessionStillStored,
            },
        )

        expect(Result.isError(result)).toBe(true)
        expect(userRepositoryMock.findById).not.toHaveBeenCalled()
    })

    it('rejects phone link confirmation when the challenge has no session binding', async () => {
        consumeAuthThrottleMock.mockResolvedValue({ allowed: true, count: 1 })
        smsAuthChallengeRepositoryMock.findById.mockResolvedValue({
            id: 'link-challenge-1',
            flow: 'link_phone',
            phone: '+14155550123',
            codeHash: hashOtp('123456'),
            providerRequestId: 'fake-link-1',
            metadata: { userId: '7', ipAddress: '127.0.0.1', provider: 'fake' },
            attemptCount: 0,
            resendAvailableAt: new Date('2099-05-15T10:01:00.000Z'),
            expiresAt: new Date('2099-05-15T10:10:00.000Z'),
            confirmedAt: null,
            invalidatedAt: null,
            createdAt: new Date('2026-05-15T10:00:00.000Z'),
            updatedAt: new Date('2026-05-15T10:00:01.000Z'),
        })

        const { authService } = await loadAuthService()
        const result = await authService.confirmPhoneLink(
            7n,
            {
                challengeId: 'link-challenge-1',
                code: '123456',
            },
            {
                ipAddress: '127.0.0.1',
                sessionId: 'session-id',
                presentedSessionToken: 'session-token',
                sessionStored: sessionStillStored,
            },
        )

        expect(Result.isError(result)).toBe(true)
        if (Result.isError(result)) {
            expect(result.error).toEqual({
                _tag: 'BadRequest',
                message: 'Phone linking challenge must be confirmed from the same session',
            })
        }
        expect(userRepositoryMock.findById).not.toHaveBeenCalled()
    })

    it('enforces resend cooldown for phone linking on the server', async () => {
        userRepositoryMock.findById.mockResolvedValue({
            id: 7n,
            email: 'user@example.com',
            phone: null,
            password: 'hashed-password',
            sessionToken: 'session-token',
        })
        validatePasswordMock.mockResolvedValue(true)
        consumeAuthThrottleMock.mockResolvedValue({ allowed: true, count: 1 })
        userRepositoryMock.phoneExistsForOtherUser.mockResolvedValue(false)
        smsAuthChallengeRepositoryMock.findLatestPendingForPhoneFlow.mockResolvedValue({
            id: 'link-challenge-pending',
            flow: 'link_phone',
            phone: '+14155550123',
            codeHash: 'hashed-code',
            providerRequestId: 'fake-link-1',
            metadata: { userId: '7', sessionId: 'session-id' },
            attemptCount: 0,
            resendAvailableAt: new Date(Date.now() + 45_000),
            expiresAt: new Date(Date.now() + 10 * 60_000),
            confirmedAt: null,
            invalidatedAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
        })

        const { authService } = await loadAuthService()
        const result = await authService.startPhoneLink(
            7n,
            {
                phone: '+1 415 555 0123',
                currentPassword: 'secret123',
            },
            {
                ipAddress: '127.0.0.1',
                sessionId: 'session-id',
                presentedSessionToken: 'session-token',
                sessionStored: sessionStillStored,
            },
        )

        expect(Result.isError(result)).toBe(true)
        if (Result.isError(result)) {
            expect(result.error._tag).toBe('RateLimited')
        }
        expect(smsAuthChallengeRepositoryMock.invalidatePendingForPhoneFlow).not.toHaveBeenCalled()
        expect(issueVerificationCodeMock).not.toHaveBeenCalled()
    })
})

// feat-096: a phone is linked only from the session that is still the user's current one.
describe('phone linking session guard (feat-096)', () => {
    const SESSION_REVOKED_ERROR = {
        _tag: 'Unauthorized',
        message: 'Session has been revoked',
        reason: 'session_revoked',
    }
    const owner = {
        id: 7n,
        email: 'user@example.com',
        phone: null,
        name: 'Jane',
        password: 'hashed-password',
        sessionToken: 'session-token',
    }
    const arrangeConfirm = (): void => {
        smsAuthChallengeRepositoryMock.findById.mockResolvedValue({
            id: 'link-challenge-1',
            flow: 'link_phone',
            phone: '+14155550123',
            codeHash: hashOtp('123456'),
            metadata: { userId: '7', sessionId: 'session-id' },
            attemptCount: 0,
            expiresAt: new Date('2099-05-15T10:10:00.000Z'),
            confirmedAt: null,
            invalidatedAt: null,
        })
        userRepositoryMock.findById.mockResolvedValue(owner)
        userRepositoryMock.phoneExistsForOtherUser.mockResolvedValue(false)
        smsAuthChallengeRepositoryMock.markConfirmed.mockResolvedValue({
            id: 'link-challenge-1',
            confirmedAt: new Date(),
        })
    }
    const confirm = async (presentedSessionToken: string | undefined) => {
        const { authService } = await loadAuthService()
        return authService.confirmPhoneLink(
            7n,
            { challengeId: 'link-challenge-1', code: '123456' },
            {
                ipAddress: '127.0.0.1',
                sessionId: 'session-id',
                presentedSessionToken,
                sessionStored: sessionStillStored,
            },
        )
    }

    it.each([
        ['no presented token', undefined],
        ['a presented token that is no longer current', 'stale-token'],
    ])('startPhoneLink refuses %s with 401 and issues no code', async (_name, presented) => {
        userRepositoryMock.findById.mockResolvedValue(owner)
        validatePasswordMock.mockResolvedValue(true)

        const { authService } = await loadAuthService()
        const result = await authService.startPhoneLink(
            7n,
            { phone: '+1 415 555 0123', currentPassword: 'secret123' },
            {
                ipAddress: '127.0.0.1',
                sessionId: 'session-id',
                presentedSessionToken: presented,
                sessionStored: sessionStillStored,
            },
        )

        expect(Result.isError(result)).toBe(true)
        if (Result.isError(result)) expect(result.error).toEqual(SESSION_REVOKED_ERROR)
        expect(validatePasswordMock).not.toHaveBeenCalled()
        expect(consumeAuthThrottleMock).not.toHaveBeenCalled()
        expect(smsAuthChallengeRepositoryMock.create).not.toHaveBeenCalled()
        expect(issueVerificationCodeMock).not.toHaveBeenCalled()
    })

    it.each([
        ['no presented token', undefined],
        ['a presented token that is no longer current', 'stale-token'],
    ])('confirmPhoneLink refuses %s with 401 and links nothing', async (_name, presented) => {
        arrangeConfirm()

        const result = await confirm(presented)

        expect(Result.isError(result)).toBe(true)
        if (Result.isError(result)) expect(result.error).toEqual(SESSION_REVOKED_ERROR)
        expect(smsAuthChallengeRepositoryMock.markConfirmed).not.toHaveBeenCalled()
        expect(userRepositoryMock.updateIfSessionToken).not.toHaveBeenCalled()
        expect(userRepositoryMock.update).not.toHaveBeenCalled()
    })

    it('confirmPhoneLink answers 401 when the session is revoked before the conditional write', async () => {
        arrangeConfirm()
        userRepositoryMock.updateIfSessionToken.mockResolvedValue(undefined)

        const result = await confirm('session-token')

        expect(Result.isError(result)).toBe(true)
        if (Result.isError(result)) expect(result.error).toEqual(SESSION_REVOKED_ERROR)
        expect(userRepositoryMock.updateIfSessionToken).toHaveBeenCalledWith(7n, 'session-token', {
            phone: '+14155550123',
        })
        expect(userRepositoryMock.update).not.toHaveBeenCalled()
    })
})

describe('auth throttle fail-closed (phone flows)', () => {
    const redisDown = (): void => {
        consumeAuthThrottleMock.mockReset()
        consumeAuthThrottleMock.mockRejectedValue(new Error('redis down'))
    }

    it('rejects phone registration start without issuing a code', async () => {
        redisDown()
        const { authService } = await loadAuthService()
        // ADR 0004: the Redis failure propagates; nothing downstream runs.
        await expect(
            authService.startPhoneRegistration(
                { phone: '+1 415 555 0123' },
                { ipAddress: '127.0.0.1', sessionId: 'session-id' },
            ),
        ).rejects.toThrow()
        expect(consumeAuthThrottleMock).toHaveBeenCalledTimes(1)
        expect(smsAuthChallengeRepositoryMock.create).not.toHaveBeenCalled()
        expect(issueVerificationCodeMock).not.toHaveBeenCalled()
    })

    it('rejects phone registration confirmation without loading the challenge', async () => {
        redisDown()
        const { authService } = await loadAuthService()
        // ADR 0004: the Redis failure propagates; nothing downstream runs.
        await expect(
            authService.confirmPhoneRegistration(
                { challengeId: 'challenge-1', code: '000000' },
                { ipAddress: '127.0.0.1' },
            ),
        ).rejects.toThrow()
        expect(consumeAuthThrottleMock).toHaveBeenCalledTimes(1)
        expect(smsAuthChallengeRepositoryMock.findById).not.toHaveBeenCalled()
    })

    it('rejects phone link start without issuing a code', async () => {
        redisDown()
        userRepositoryMock.findById.mockResolvedValue({
            id: 7n,
            email: 'user@example.com',
            phone: null,
            password: 'hashed-password',
            sessionToken: 'session-token',
        })
        validatePasswordMock.mockResolvedValue(true)
        const { authService } = await loadAuthService()
        // ADR 0004: the Redis failure propagates; nothing downstream runs.
        await expect(
            authService.startPhoneLink(
                7n,
                { phone: '+1 415 555 0123', currentPassword: 'secret123' },
                {
                    ipAddress: '127.0.0.1',
                    sessionId: 'session-id',
                    presentedSessionToken: 'session-token',
                    sessionStored: sessionStillStored,
                },
            ),
        ).rejects.toThrow()
        expect(consumeAuthThrottleMock).toHaveBeenCalledTimes(1)
        expect(smsAuthChallengeRepositoryMock.create).not.toHaveBeenCalled()
        expect(issueVerificationCodeMock).not.toHaveBeenCalled()
    })

    it('rejects phone link confirmation without loading the challenge', async () => {
        redisDown()
        const { authService } = await loadAuthService()
        // ADR 0004: the Redis failure propagates; nothing downstream runs.
        await expect(
            authService.confirmPhoneLink(
                7n,
                { challengeId: 'link-challenge-1', code: '123456' },
                {
                    ipAddress: '127.0.0.1',
                    sessionId: 'session-id',
                    presentedSessionToken: 'session-token',
                    sessionStored: sessionStillStored,
                },
            ),
        ).rejects.toThrow()
        expect(consumeAuthThrottleMock).toHaveBeenCalledTimes(1)
        expect(smsAuthChallengeRepositoryMock.findById).not.toHaveBeenCalled()
    })
})

describe('login throttle', () => {
    const login = async (identifier: string, ipAddress = '127.0.0.1') => {
        const { authService } = await loadAuthService()
        return authService.login(
            { identifier, password: 'secret123' },
            authMock as any,
            sessionMock as any,
            { ipAddress },
        )
    }
    const invalid = {
        _tag: 'Unauthorized',
        message: 'Invalid email or password',
    }
    const scopesCalled = (): string[] =>
        consumeAuthThrottleMock.mock.calls.map((call) => (call[0] as { scope: string }).scope)

    beforeEach(() => {
        consumeAuthThrottleMock.mockReset()
        consumeAuthThrottleMock.mockResolvedValue({ allowed: true, count: 1 })
        resetAuthThrottleMock.mockReset()
        resetAuthThrottleMock.mockResolvedValue(undefined)
    })

    it('resolveLoginKey matches the lookup normalization for email and phone', async () => {
        const { resolveLoginKey } = await loadAuthService()
        expect(resolveLoginKey('  User@Example.COM ')).toEqual({
            kind: 'email',
            value: 'user@example.com',
        })
        expect(resolveLoginKey('+1 415 555 0123')).toEqual(resolveLoginKey('+1 (415) 555-0123'))
        expect(resolveLoginKey('+1 415 555 0123')).toEqual({
            kind: 'phone',
            value: '+14155550123',
        })
        expect(resolveLoginKey('not-an-identifier')).toBeNull()
    })

    it('consumes the IP and identifier budgets before the user lookup', async () => {
        userRepositoryMock.findByEmail.mockResolvedValue(undefined)
        await login('User@Example.com')
        expect(scopesCalled()).toEqual(['login_ip', 'login_identifier'])
        expect(consumeAuthThrottleMock.mock.calls[1]?.[1]).toBe('user@example.com')
        expect(consumeAuthThrottleMock.mock.invocationCallOrder[1]).toBeLessThan(
            userRepositoryMock.findByEmail.mock.invocationCallOrder[0] ?? 0,
        )
    })

    it.each([
        ['IP', 0],
        ['identifier', 1],
    ])('stops before the lookup and password check when the %s budget is spent', async (_n, at) => {
        consumeAuthThrottleMock.mockReset()
        consumeAuthThrottleMock.mockResolvedValue({ allowed: true, count: 1 })
        if (at === 0)
            consumeAuthThrottleMock.mockResolvedValueOnce({
                allowed: false,
                count: 21,
            })
        else
            consumeAuthThrottleMock
                .mockResolvedValueOnce({ allowed: true, count: 1 })
                .mockResolvedValueOnce({ allowed: false, count: 41 })
        const result = await login('user@example.com')
        expect(Result.isError(result) && result.error).toEqual(invalid)
        expect(userRepositoryMock.findByEmail).not.toHaveBeenCalled()
        expect(validatePasswordMock).not.toHaveBeenCalled()
    })

    it('charges the same budget and answers the same for unknown, wrong-password and no-password accounts', async () => {
        const outcomes = []
        for (const user of [
            undefined,
            { id: 1n, email: 'user@example.com', password: 'hash' },
            { id: 1n, email: 'user@example.com', password: null },
        ]) {
            consumeAuthThrottleMock.mockClear()
            userRepositoryMock.findByEmail.mockResolvedValue(user)
            validatePasswordMock.mockResolvedValue(false)
            const result = await login('user@example.com')
            outcomes.push({
                error: Result.isError(result) && result.error,
                calls: scopesCalled(),
            })
        }
        for (const outcome of outcomes) {
            expect(outcome).toEqual({
                error: invalid,
                calls: ['login_ip', 'login_identifier'],
            })
        }
        expect(resetAuthThrottleMock).not.toHaveBeenCalled()
    })

    it('counts only the IP for an identifier that cannot be normalized', async () => {
        await login('not-an-identifier')
        expect(scopesCalled()).toEqual(['login_ip'])
    })

    it('fails closed on a Redis error without looking up the user', async () => {
        consumeAuthThrottleMock.mockReset()
        consumeAuthThrottleMock.mockRejectedValue(new Error('redis down'))
        // ADR 0004: the Redis failure propagates; nothing downstream runs.
        await expect(login('user@example.com')).rejects.toThrow()
        expect(userRepositoryMock.findByEmail).not.toHaveBeenCalled()
        expect(validatePasswordMock).not.toHaveBeenCalled()
    })

    it('resets only the identifier budget after a successful login', async () => {
        userRepositoryMock.findByPhone.mockResolvedValue({
            id: 7n,
            email: null,
            phone: '+14155550123',
            name: 'Jane',
            password: 'hashed-password',
            sessionToken: 'session-token',
        })
        validatePasswordMock.mockResolvedValue(true)
        authMock.login.mockResolvedValue(true)
        generateWsTokenMock.mockResolvedValue('ws-token')
        const result = await login('+1 415 555 0123')
        expect(Result.isOk(result)).toBe(true)
        expect(resetAuthThrottleMock).toHaveBeenCalledTimes(1)
        expect(resetAuthThrottleMock).toHaveBeenCalledWith(
            expect.objectContaining({ scope: 'login_identifier' }),
            '+14155550123',
        )
    })
})

// feat-100: the number was taken after the lookup; the unique index answers. The same 409 as
// the lookup, not 500, and nothing after the write runs.
describe('phone writes losing the race to the unique index', () => {
    const uniqueViolation = new Error('Failed query', {
        cause: Object.assign(new Error('duplicate key'), { code: '23505' }),
    })

    it('completePhoneRegistration answers 409 Phone already exist', async () => {
        smsAuthChallengeRepositoryMock.findById.mockResolvedValue({
            id: 'challenge-1',
            flow: 'register_phone',
            phone: '+14155550123',
            codeHash: 'hashed-code',
            providerRequestId: 'fake-1',
            metadata: { sessionId: 'session-id' },
            attemptCount: 0,
            resendAvailableAt: new Date('2099-05-15T10:01:00.000Z'),
            expiresAt: new Date('2099-05-15T10:10:00.000Z'),
            confirmedAt: new Date('2026-05-15T10:00:30.000Z'),
            invalidatedAt: null,
            createdAt: new Date('2026-05-15T10:00:00.000Z'),
            updatedAt: new Date('2026-05-15T10:00:30.000Z'),
        })
        userRepositoryMock.findByPhone.mockResolvedValue(undefined)
        hashPasswordMock.mockResolvedValue('hashed-password')
        userRepositoryMock.create.mockRejectedValue(uniqueViolation)

        const { authService } = await loadAuthService()
        const result = await authService.completePhoneRegistration(
            { challengeId: 'challenge-1', name: 'Phone User', password: 'secret123' },
            authMock as any,
            sessionMock as any,
            loggerMock as any,
            { sessionId: 'session-id' },
        )

        expect(Result.isError(result) && result.error).toEqual({
            _tag: 'Conflict',
            message: 'Phone already exist',
        })
        expect(smsAuthChallengeRepositoryMock.markInvalidated).not.toHaveBeenCalled()
        expect(sessionMock.destroySession).not.toHaveBeenCalled()
        expect(authMock.login).not.toHaveBeenCalled()
    })

    const linkChallenge = () => ({
        id: 'link-challenge-1',
        flow: 'link_phone',
        phone: '+14155550123',
        codeHash: hashOtp('123456'),
        providerRequestId: 'fake-link-1',
        metadata: {
            userId: '7',
            ipAddress: '127.0.0.1',
            provider: 'fake',
            sessionId: 'session-id',
        },
        attemptCount: 0,
        resendAvailableAt: new Date('2099-05-15T10:01:00.000Z'),
        expiresAt: new Date('2099-05-15T10:10:00.000Z'),
        confirmedAt: null,
        invalidatedAt: null,
        createdAt: new Date('2026-05-15T10:00:00.000Z'),
        updatedAt: new Date('2026-05-15T10:00:01.000Z'),
    })

    const confirmLink = async () => {
        smsAuthChallengeRepositoryMock.findById.mockResolvedValue(linkChallenge())
        userRepositoryMock.findById.mockResolvedValue({
            id: 7n,
            email: 'user@example.com',
            phone: null,
            name: 'Jane',
            password: 'hashed-password',
            sessionToken: 'session-token',
        })
        userRepositoryMock.phoneExistsForOtherUser.mockResolvedValue(false)
        smsAuthChallengeRepositoryMock.markConfirmed.mockResolvedValue({
            id: 'link-challenge-1',
            confirmedAt: new Date(),
        })

        const { authService } = await loadAuthService()
        return await authService.confirmPhoneLink(
            7n,
            { challengeId: 'link-challenge-1', code: '123456' },
            {
                ipAddress: '127.0.0.1',
                sessionId: 'session-id',
                presentedSessionToken: 'session-token',
                sessionStored: sessionStillStored,
            },
        )
    }

    it('confirmPhoneLink answers 409 Phone is already linked to another account', async () => {
        userRepositoryMock.updateIfSessionToken.mockRejectedValue(uniqueViolation)

        const result = await confirmLink()

        expect(Result.isError(result) && result.error).toEqual({
            _tag: 'Conflict',
            message: 'Phone is already linked to another account',
        })
    })

    it('confirmPhoneLink still throws any other database error', async () => {
        userRepositoryMock.updateIfSessionToken.mockRejectedValue(new Error('connection lost'))

        await expect(confirmLink()).rejects.toThrow('connection lost')
    })
})
