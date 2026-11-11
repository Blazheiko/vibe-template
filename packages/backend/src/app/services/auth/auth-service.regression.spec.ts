import { Result } from 'better-result'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// feat-129: the session-still-stored guard is required; these cases keep the session.
const sessionStillStored = (): Promise<boolean> => Promise.resolve(true)

const userRepositoryMock = {
    findByEmail: vi.fn(),
    findById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    changePasswordIfCurrent: vi.fn(),
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
const sendVerificationEmailAfterRegistrationMock = vi.fn()

vi.mock('#app/repositories/index.js', () => ({
    // feat-109: change-password and logout-all retire the pending reset links.
    passwordResetRepository: { invalidatePendingByUserId: vi.fn().mockResolvedValue(0) },
    smsAuthChallengeRepository: { invalidatePendingForPhoneFlow: vi.fn().mockResolvedValue(0) },
    withTransaction: <T>(work: (tx: unknown) => Promise<T>): Promise<T> => work({}),
    userRepository: userRepositoryMock,
}))

vi.mock('#app/transformers/index.js', () => ({
    userTransformer: {
        serialize: vi.fn((user: { id: bigint; email: string | null; name?: string | null }) => ({
            id: String(user.id),
            email: user.email,
            name: user.name ?? '',
        })),
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
        sendVerificationEmailAfterRegistration: sendVerificationEmailAfterRegistrationMock,
    },
}))

vi.mock('#app/services/auth/auth-throttle-service.js', () => ({
    consumeAuthThrottle: consumeAuthThrottleMock,
    resetAuthThrottle: resetAuthThrottleMock,
}))

async function loadAuthService() {
    return import('./auth-service.js')
}

beforeEach(() => {
    consumeAuthThrottleMock.mockReset()
    consumeAuthThrottleMock.mockResolvedValue({ allowed: true, count: 1 })
    resetAuthThrottleMock.mockReset()
    resetAuthThrottleMock.mockResolvedValue(undefined)
})

afterEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    sessionMock.sessionInfo = {
        id: 'session-id',
        data: {},
    }
})

describe('authService legacy regressions', () => {
    it('normalizes email casing during registration lookup and create', async () => {
        consumeAuthThrottleMock.mockResolvedValue({ allowed: true, count: 1 })
        userRepositoryMock.findByEmail.mockResolvedValue(undefined)
        hashPasswordMock.mockResolvedValue('hashed-password')
        userRepositoryMock.create.mockResolvedValue({
            id: 7n,
            email: 'user@example.com',
            name: 'Jane',
            sessionToken: 'session-token',
        })
        sessionMock.destroySession.mockResolvedValue(undefined)
        authMock.login.mockResolvedValue(true)
        generateWsTokenMock.mockResolvedValue('ws-token')

        const { authService } = await loadAuthService()
        const result = await authService.registerByEmail(
            {
                name: 'Jane',
                email: 'User@Example.com',
                password: 'secret123',
                token: '',
            },
            authMock as any,
            sessionMock as any,
            loggerMock as any,
            { ipAddress: '127.0.0.1' },
        )

        expect(Result.isOk(result)).toBe(true)
        if (Result.isOk(result)) {
            expect(result.value).toEqual({
                status: 'success',
                message:
                    'If the email can be used for registration, continue with the verification instructions sent to your inbox.',
            })
        }
        expect(userRepositoryMock.findByEmail).toHaveBeenCalledWith('user@example.com')
        expect(consumeAuthThrottleMock).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                scope: 'register_email_ip',
                limit: 10,
                windowMs: 60 * 60 * 1000,
            }),
            '127.0.0.1',
        )
        expect(consumeAuthThrottleMock).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                scope: 'register_email_identifier',
                limit: 3,
                windowMs: 60 * 60 * 1000,
            }),
            'user@example.com',
        )
        expect(userRepositoryMock.create).toHaveBeenCalledWith(
            expect.objectContaining({
                email: 'user@example.com',
                password: 'hashed-password',
            }),
        )
        expect(authMock.login).not.toHaveBeenCalled()
        expect(generateWsTokenMock).not.toHaveBeenCalled()
    })

    it('returns a generic success response when the registration email already exists', async () => {
        consumeAuthThrottleMock.mockResolvedValue({ allowed: true, count: 1 })
        userRepositoryMock.findByEmail.mockResolvedValue({
            id: 42n,
            email: 'user@example.com',
            name: 'Existing',
            password: 'hashed-password',
            sessionToken: 'existing-session-token',
        })

        const { authService } = await loadAuthService()
        const result = await authService.registerByEmail(
            {
                name: 'Jane',
                email: 'User@Example.com',
                password: 'secret123',
                token: '',
            },
            authMock as any,
            sessionMock as any,
            loggerMock as any,
            { ipAddress: '127.0.0.1' },
        )

        expect(Result.isOk(result)).toBe(true)
        if (Result.isOk(result)) {
            expect(result.value).toEqual({
                status: 'success',
                message:
                    'If the email can be used for registration, continue with the verification instructions sent to your inbox.',
            })
        }
        expect(userRepositoryMock.create).not.toHaveBeenCalled()
        expect(authMock.login).not.toHaveBeenCalled()
    })

    it('logs in with a case-insensitive email identifier and returns websocket details', async () => {
        consumeAuthThrottleMock.mockResolvedValue({ allowed: true, count: 1 })
        userRepositoryMock.findByEmail.mockResolvedValue({
            id: 7n,
            email: 'user@example.com',
            emailVerifiedAt: new Date('2026-05-30T00:00:00.000Z'),
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
                identifier: 'User@Example.com',
                password: 'secret123',
                token: '',
            },
            authMock as any,
            sessionMock as any,
            { ipAddress: '127.0.0.1' },
        )

        expect(userRepositoryMock.findByEmail).toHaveBeenCalledWith('user@example.com')
        expect(validatePasswordMock).toHaveBeenCalledWith('secret123', 'hashed-password')
        expect(authMock.login).toHaveBeenCalledWith('7', 'session-token')
        expect(Result.isOk(result)).toBe(true)
        if (Result.isOk(result)) {
            expect(result.value).toEqual({
                status: 'success',
                user: {
                    id: '7',
                    email: 'user@example.com',
                    name: 'Jane',
                },
                wsUrl: 'wss://example.com/ws',
                wsToken: 'ws-token',
            })
        }
    })

    // Every miss runs scrypt once, like a wrong password: a fast answer would tell that the
    // address is not registered or belongs to an OAuth-only account.
    describe.each([
        { label: 'an unknown email', user: undefined },
        {
            label: 'an account without a local password',
            user: {
                id: 7n,
                email: 'user@example.com',
                emailVerifiedAt: new Date('2026-05-30T00:00:00.000Z'),
                password: null,
                sessionToken: 'session-token',
            },
        },
        {
            label: 'an account with an empty password hash',
            user: {
                id: 7n,
                email: 'user@example.com',
                emailVerifiedAt: new Date('2026-05-30T00:00:00.000Z'),
                password: '',
                sessionToken: 'session-token',
            },
        },
    ])('login to $label', ({ user }) => {
        async function attemptLogin() {
            const { authService } = await loadAuthService()
            return authService.login(
                {
                    identifier: 'user@example.com',
                    password: 'secret123',
                    token: '',
                },
                authMock as any,
                sessionMock as any,
                { ipAddress: '127.0.0.1' },
            )
        }

        beforeEach(() => {
            userRepositoryMock.findByEmail.mockResolvedValue(user)
            hashPasswordMock.mockResolvedValue('dummy-hash')
        })

        it('checks the password against the dummy hash and answers like a wrong password', async () => {
            validatePasswordMock.mockResolvedValue(false)

            const result = await attemptLogin()

            expect(Result.isError(result)).toBe(true)
            if (Result.isError(result)) {
                expect(result.error).toEqual({
                    _tag: 'Unauthorized',
                    message: 'Invalid email or password',
                })
            }
            expect(validatePasswordMock).toHaveBeenCalledTimes(1)
            expect(validatePasswordMock).toHaveBeenCalledWith('secret123', 'dummy-hash')
            expect(authMock.login).not.toHaveBeenCalled()
        })

        it('never signs in, even when the dummy hash check passes', async () => {
            validatePasswordMock.mockResolvedValue(true)

            const result = await attemptLogin()

            expect(Result.isError(result)).toBe(true)
            if (Result.isError(result)) {
                expect(result.error).toEqual({
                    _tag: 'Unauthorized',
                    message: 'Invalid email or password',
                })
            }
            expect(authMock.login).not.toHaveBeenCalled()
            expect(resetAuthThrottleMock).not.toHaveBeenCalled()
        })

        it('hashes the dummy password once for repeated misses', async () => {
            validatePasswordMock.mockResolvedValue(false)

            await attemptLogin()
            await attemptLogin()

            expect(hashPasswordMock).toHaveBeenCalledTimes(1)
            expect(validatePasswordMock).toHaveBeenCalledTimes(2)
        })
    })

    it('requires the current password before changing an existing password', async () => {
        userRepositoryMock.findById.mockResolvedValue({
            id: 7n,
            password: 'stored-password-hash',
            sessionToken: 'previous-session-token',
        })

        const { authService } = await loadAuthService()
        const result = await authService.changePassword(
            7n,
            { newPassword: 'new-password-123' },
            'previous-session-token',
            sessionStillStored,
        )

        expect(Result.isError(result)).toBe(true)
        if (Result.isError(result)) {
            expect(result.error).toEqual({
                _tag: 'BadRequest',
                message: 'Current password is required',
            })
        }
        expect(hashPasswordMock).not.toHaveBeenCalled()
        expect(userRepositoryMock.update).not.toHaveBeenCalled()
        expect(userRepositoryMock.changePasswordIfCurrent).not.toHaveBeenCalled()
    })

    it('allows setting a first password for accounts that do not already have one', async () => {
        userRepositoryMock.findById.mockResolvedValue({
            id: 9n,
            password: null,
            sessionToken: 'previous-session-token',
        })
        hashPasswordMock.mockResolvedValue('new-password-hash')
        userRepositoryMock.changePasswordIfCurrent.mockResolvedValue({
            id: 9n,
            password: 'new-password-hash',
        })

        const { authService } = await loadAuthService()
        const result = await authService.changePassword(
            9n,
            { newPassword: 'new-password-123' },
            'previous-session-token',
            sessionStillStored,
        )

        expect(hashPasswordMock).toHaveBeenCalledWith('new-password-123')
        // No password stored yet: the conditional update expects exactly that (null).
        expect(userRepositoryMock.changePasswordIfCurrent).toHaveBeenCalledWith(
            9n,
            null,
            'previous-session-token',
            { password: 'new-password-hash', sessionToken: expect.any(String) },
            expect.anything(),
        )
        expect(Result.isOk(result)).toBe(true)
        if (Result.isOk(result)) {
            expect(result.value).toEqual({ status: 'success', sessionToken: expect.any(String) })
        }
    })
})

describe('auth throttle fail-closed (email registration)', () => {
    it('rejects registration without looking up or creating the user', async () => {
        consumeAuthThrottleMock.mockReset()
        consumeAuthThrottleMock.mockRejectedValue(new Error('redis down'))

        const { authService } = await loadAuthService()
        // ADR 0004: the Redis failure propagates; nothing downstream runs.
        await expect(
            authService.registerByEmail(
                { name: 'Jane', email: 'user@example.com', password: 'secret123', token: '' },
                authMock as any,
                sessionMock as any,
                loggerMock as any,
                { ipAddress: '127.0.0.1' },
            ),
        ).rejects.toThrow()
        expect(consumeAuthThrottleMock).toHaveBeenCalledTimes(1)
        expect(userRepositoryMock.findByEmail).not.toHaveBeenCalled()
        expect(userRepositoryMock.create).not.toHaveBeenCalled()
    })
})

describe('change password throttle', () => {
    it.each([
        [
            'the budget is spent',
            () => consumeAuthThrottleMock.mockResolvedValue({ allowed: false, count: 11 }),
        ],
        ['Redis fails', () => consumeAuthThrottleMock.mockRejectedValue(new Error('redis down'))],
    ])('rejects without checking the current password when %s', async (_name, arrange) => {
        arrange()
        userRepositoryMock.findById.mockResolvedValue({
            id: 7n,
            password: 'stored-password-hash',
            sessionToken: 'previous-session-token',
        })
        const { authService } = await loadAuthService()
        // A spent budget answers Result.err; a Redis failure rejects (ADR 0004). Both refuse.
        const refused = await authService
            .changePassword(
                7n,
                { currentPassword: 'guess', newPassword: 'new-password-123' },
                'previous-session-token',
                sessionStillStored,
            )
            .then(
                (result) => Result.isError(result),
                () => true,
            )
        expect(refused).toBe(true)
        expect(consumeAuthThrottleMock).toHaveBeenCalledWith(
            expect.objectContaining({
                scope: 'change_password_user',
                limit: 10,
                windowMs: 900_000,
            }),
            '7',
        )
        expect(validatePasswordMock).not.toHaveBeenCalled()
        expect(userRepositoryMock.update).not.toHaveBeenCalled()
    })

    it('resets the budget after a successful change', async () => {
        userRepositoryMock.findById.mockResolvedValue({
            id: 7n,
            password: 'stored-password-hash',
            sessionToken: 'previous-session-token',
        })
        validatePasswordMock.mockResolvedValue(true)
        hashPasswordMock.mockResolvedValue('new-password-hash')
        userRepositoryMock.changePasswordIfCurrent.mockResolvedValue({ id: 7n })
        const { authService } = await loadAuthService()
        const result = await authService.changePassword(
            7n,
            { currentPassword: 'secret123', newPassword: 'new-password-123' },
            'previous-session-token',
            sessionStillStored,
        )
        expect(Result.isOk(result)).toBe(true)
        expect(resetAuthThrottleMock).toHaveBeenCalledWith(
            expect.objectContaining({ scope: 'change_password_user' }),
            '7',
        )
    })
})

// feat-100: two registrations with one email both pass the lookup; the second insert hits the
// unique index. The loser answers like a taken address instead of 500, without side effects.
describe('email registration losing the race to the unique index', () => {
    const GENERIC = {
        status: 'success',
        message:
            'If the email can be used for registration, continue with the verification instructions sent to your inbox.',
    }
    const pgUniqueViolation = Object.assign(new Error('duplicate key'), { code: '23505' })
    const drizzleWrapped = new Error('Failed query: insert into "users"', {
        cause: pgUniqueViolation,
    })

    const register = async () => {
        const { authService } = await loadAuthService()
        return await authService.registerByEmail(
            { name: 'Jane', email: 'user@example.com', password: 'secret123', token: '' },
            authMock as any,
            sessionMock as any,
            loggerMock as any,
            { ipAddress: '127.0.0.1' },
        )
    }

    const savedStrict = process.env['AUTH_STRICT_REGISTRATION']
    afterEach(() => {
        if (savedStrict === undefined) delete process.env['AUTH_STRICT_REGISTRATION']
        else process.env['AUTH_STRICT_REGISTRATION'] = savedStrict
    })

    describe.each([
        ['strict', 'true'],
        ['non-strict', 'false'],
    ])('%s registration', (_mode, strict) => {
        beforeEach(() => {
            process.env['AUTH_STRICT_REGISTRATION'] = strict
            userRepositoryMock.findByEmail.mockResolvedValue(undefined)
            hashPasswordMock.mockResolvedValue('hashed-password')
        })

        it.each([
            ['the driver error', pgUniqueViolation],
            ['the error wrapped by Drizzle', drizzleWrapped],
        ])('answers the generic message for %s', async (_label, err) => {
            userRepositoryMock.create.mockRejectedValue(err)

            const result = await register()

            expect(Result.isOk(result) && result.value).toEqual(GENERIC)
            expect(sendVerificationEmailAfterRegistrationMock).not.toHaveBeenCalled()
            // feat-157: strict mode ends the caller's session in every branch, the lost race
            // included; the non-strict mode leaves it.
            expect(sessionMock.destroySession).toHaveBeenCalledTimes(strict === 'true' ? 1 : 0)
            expect(authMock.login).not.toHaveBeenCalled()
        })

        it('still throws any other database error', async () => {
            userRepositoryMock.create.mockRejectedValue(
                Object.assign(new Error('connection lost'), { code: '08006' }),
            )

            await expect(register()).rejects.toThrow('connection lost')
        })
    })
})
