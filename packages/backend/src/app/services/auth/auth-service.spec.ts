import { Result } from 'better-result'
import { throttlePolicies } from '#config/throttle-policies.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ORIGINAL_ENV = { ...process.env }

const userRepositoryMock = {
    findByEmail: vi.fn(),
    findById: vi.fn(),
    emailExistsForOtherUser: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    changePasswordIfCurrent: vi.fn(),
}

const authMock = {
    login: vi.fn(),
    logout: vi.fn(),
    logoutAll: vi.fn(),
    getUserId: vi.fn(() => '7'),
}

const securityNotice = vi.fn()
vi.mock('#app/services/notifications/user-notification-service.js', () => ({
    userNotificationService: { security: securityNotice, supportReply: vi.fn() },
}))

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
const sendLinkVerificationEmailMock = vi.fn()
const sendVerificationEmailInBackgroundMock = vi.fn()
const destroyAllSessionsMock = vi.fn()
const ROTATED_LOGOUT_CSRF_TOKEN = 'b'.repeat(43)
const ROTATED_LOGOUT_ALL_CSRF_TOKEN = 'c'.repeat(43)

vi.mock('#app/repositories/index.js', () => ({
    userRepository: userRepositoryMock,
}))

vi.mock('#app/transformers/index.js', () => ({
    userTransformer: {
        serialize: vi.fn((user: { id: bigint; email: string }) => ({
            id: String(user.id),
            email: user.email,
        })),
    },
}))

// The real module loads config/session, which needs metautil's duration().
vi.mock('#vendor/utils/session/redis-session-storage.js', () => ({
    destroyAllSessions: destroyAllSessionsMock,
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
        sendLinkVerificationEmail: sendLinkVerificationEmailMock,
        sendVerificationEmailInBackground: sendVerificationEmailInBackgroundMock,
    },
}))

vi.mock('#app/services/auth/auth-throttle-service.js', () => ({
    consumeAuthThrottle: consumeAuthThrottleMock,
    resetAuthThrottle: resetAuthThrottleMock,
}))

async function loadAuthService() {
    return import('./auth-service.js')
}

function restoreEnv(): void {
    for (const key of Object.keys(process.env)) {
        if (!(key in ORIGINAL_ENV)) {
            delete process.env[key]
        }
    }

    Object.assign(process.env, ORIGINAL_ENV)
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
    restoreEnv()
    sessionMock.sessionInfo = {
        id: 'session-id',
        data: {},
    }
})

describe('authService', () => {
    it('registers a new email user and returns a generic accepted response', async () => {
        consumeAuthThrottleMock.mockResolvedValue({ allowed: true, count: 1 })
        userRepositoryMock.findByEmail.mockResolvedValue(undefined)
        hashPasswordMock.mockResolvedValue('hashed-password')
        userRepositoryMock.create.mockResolvedValue({
            id: 7n,
            email: 'user@example.com',
            sessionToken: 'session-token',
        })
        sessionMock.destroySession.mockResolvedValue(undefined)

        const { authService } = await loadAuthService()
        const result = await authService.registerByEmail(
            {
                name: 'Jane',
                email: 'user@example.com',
                password: 'secret',
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
        expect(sessionMock.destroySession).toHaveBeenCalledWith('session-id')
        expect(authMock.login).not.toHaveBeenCalled()
        expect(generateWsTokenMock).not.toHaveBeenCalled()
    })

    it('registers and authenticates an email user immediately when strict registration is disabled', async () => {
        process.env['AUTH_STRICT_REGISTRATION'] = 'false'
        consumeAuthThrottleMock.mockResolvedValue({ allowed: true, count: 1 })
        userRepositoryMock.findByEmail.mockResolvedValue(undefined)
        hashPasswordMock.mockResolvedValue('hashed-password')
        userRepositoryMock.create.mockResolvedValue({
            id: 7n,
            email: 'user@example.com',
            sessionToken: 'session-token',
        })
        sessionMock.destroySession.mockResolvedValue(undefined)
        authMock.login.mockResolvedValue(true)
        generateWsTokenMock.mockResolvedValue('ws-token')

        const { authService } = await loadAuthService()
        const result = await authService.registerByEmail(
            {
                name: 'Jane',
                email: 'user@example.com',
                password: 'secret',
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
                user: {
                    id: '7',
                    email: 'user@example.com',
                },
                wsUrl: 'wss://example.com/ws',
                wsToken: 'ws-token',
            })
        }
        expect(sendVerificationEmailAfterRegistrationMock).toHaveBeenCalledWith(7n)
        expect(sessionMock.destroySession).toHaveBeenCalledWith('session-id')
        expect(authMock.login).toHaveBeenCalledWith('7', 'session-token')
        expect(generateWsTokenMock).toHaveBeenCalledWith(sessionMock.sessionInfo, '7')
    })

    it('returns a generic success when register email already exists', async () => {
        consumeAuthThrottleMock.mockResolvedValue({ allowed: true, count: 1 })
        hashPasswordMock.mockResolvedValue('hashed-password')
        userRepositoryMock.findByEmail.mockResolvedValue({
            id: 7n,
            email: 'user@example.com',
        })

        const { authService } = await loadAuthService()
        const result = await authService.registerByEmail(
            {
                name: 'Jane',
                email: 'user@example.com',
                password: 'secret',
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
    })

    // F2 (feat-066): hashing a password costs tens of milliseconds. When only a NEW address was
    // hashed, the time of the answer told an attacker whether the address was taken.
    describe('registration cost does not depend on whether the address is taken', () => {
        const HASH_MS = 40
        const register = async () => {
            const { authService } = await loadAuthService()
            const started = performance.now()
            const result = await authService.registerByEmail(
                { name: 'Jane', email: 'user@example.com', password: 'secret', token: '' },
                authMock as any,
                sessionMock as any,
                loggerMock as any,
                { ipAddress: '127.0.0.1' },
            )
            return { result, elapsed: performance.now() - started }
        }
        const slowHash = (): void => {
            hashPasswordMock.mockImplementation(
                () =>
                    new Promise((resolve) =>
                        setTimeout(() => {
                            resolve('hashed')
                        }, HASH_MS),
                    ),
            )
        }

        it('hashes the password for an address that is taken', async () => {
            consumeAuthThrottleMock.mockResolvedValue({ allowed: true, count: 1 })
            hashPasswordMock.mockResolvedValue('hashed')
            userRepositoryMock.findByEmail.mockResolvedValue({ id: 7n, email: 'user@example.com' })

            await register()

            expect(hashPasswordMock).toHaveBeenCalledTimes(1)
            expect(hashPasswordMock).toHaveBeenCalledWith('secret')
        })

        it('hashes the password for a new address', async () => {
            consumeAuthThrottleMock.mockResolvedValue({ allowed: true, count: 1 })
            hashPasswordMock.mockResolvedValue('hashed')
            userRepositoryMock.findByEmail.mockResolvedValue(undefined)
            userRepositoryMock.create.mockResolvedValue({ id: 8n, sessionToken: 't' })
            sessionMock.destroySession.mockResolvedValue(undefined)

            await register()

            expect(hashPasswordMock).toHaveBeenCalledTimes(1)
        })

        it('hashes before it looks the address up', async () => {
            consumeAuthThrottleMock.mockResolvedValue({ allowed: true, count: 1 })
            hashPasswordMock.mockResolvedValue('hashed')
            userRepositoryMock.findByEmail.mockResolvedValue(undefined)
            userRepositoryMock.create.mockResolvedValue({ id: 8n, sessionToken: 't' })
            sessionMock.destroySession.mockResolvedValue(undefined)

            await register()

            expect(hashPasswordMock.mock.invocationCallOrder[0]).toBeLessThan(
                userRepositoryMock.findByEmail.mock.invocationCallOrder[0] ?? 0,
            )
        })

        it('takes as long for a taken address as for a new one', async () => {
            consumeAuthThrottleMock.mockResolvedValue({ allowed: true, count: 1 })
            slowHash()
            userRepositoryMock.create.mockResolvedValue({ id: 8n, sessionToken: 't' })
            sessionMock.destroySession.mockResolvedValue(undefined)

            userRepositoryMock.findByEmail.mockResolvedValue({ id: 7n, email: 'user@example.com' })
            const taken = await register()
            userRepositoryMock.findByEmail.mockResolvedValue(undefined)
            const fresh = await register()

            expect(taken.elapsed).toBeGreaterThanOrEqual(HASH_MS * 0.8)
            expect(fresh.elapsed).toBeGreaterThanOrEqual(HASH_MS * 0.8)
            expect(Math.abs(taken.elapsed - fresh.elapsed)).toBeLessThan(HASH_MS)
            // Same answer, too.
            expect(Result.isOk(taken.result) && taken.result.value).toEqual(
                Result.isOk(fresh.result) && fresh.result.value,
            )
        })

        it('does not hash when the throttle already refused', async () => {
            consumeAuthThrottleMock.mockResolvedValue({ allowed: false, count: 99 })

            await register()

            expect(hashPasswordMock).not.toHaveBeenCalled()
        })
    })

    it('returns internal error when login session establishment fails', async () => {
        consumeAuthThrottleMock.mockResolvedValue({ allowed: true, count: 1 })
        userRepositoryMock.findByEmail.mockResolvedValue({
            id: 7n,
            email: 'user@example.com',
            emailVerifiedAt: new Date('2026-05-30T00:00:00.000Z'),
            password: 'hashed-password',
            sessionToken: 'session-token',
        })
        validatePasswordMock.mockResolvedValue(true)
        authMock.login.mockResolvedValue(false)

        const { authService } = await loadAuthService()
        const result = await authService.login(
            {
                email: 'user@example.com',
                password: 'secret',
                token: '',
            },
            authMock as any,
            sessionMock as any,
            { ipAddress: '127.0.0.1' },
        )

        expect(Result.isError(result)).toBe(true)
        if (Result.isError(result)) {
            expect(result.error).toEqual({
                _tag: 'Internal',
                publicMessage: 'Failed to log in user',
            })
        }
        expect(generateWsTokenMock).not.toHaveBeenCalled()
        // No sign-in push when the session was not established (code-issues item 72).
        expect(securityNotice).not.toHaveBeenCalled()
    })

    it('sends a new sign-in push after a successful login', async () => {
        consumeAuthThrottleMock.mockResolvedValue({ allowed: true, count: 1 })
        userRepositoryMock.findByEmail.mockResolvedValue({
            id: 7n,
            email: 'user@example.com',
            emailVerifiedAt: new Date('2026-05-30T00:00:00.000Z'),
            password: 'hashed-password',
            sessionToken: 'session-token',
        })
        validatePasswordMock.mockResolvedValue(true)
        authMock.login.mockResolvedValue(true)

        const { authService } = await loadAuthService()
        const result = await authService.login(
            { email: 'user@example.com', password: 'secret', token: '' },
            authMock as any,
            sessionMock as any,
            { ipAddress: '127.0.0.1' },
        )

        expect(Result.isOk(result)).toBe(true)
        expect(securityNotice).toHaveBeenCalledWith(7n, 'new_sign_in')
    })

    it('starts email linking for a phone-only account after re-authentication', async () => {
        userRepositoryMock.findById.mockResolvedValue({
            id: 9n,
            email: null,
            password: 'stored-password-hash',
        })
        validatePasswordMock.mockResolvedValue(true)
        consumeAuthThrottleMock
            .mockResolvedValueOnce({ allowed: true, count: 1 })
            .mockResolvedValueOnce({ allowed: true, count: 1 })
            .mockResolvedValueOnce({ allowed: true, count: 1 })
        userRepositoryMock.emailExistsForOtherUser.mockResolvedValue(false)
        sendLinkVerificationEmailMock.mockResolvedValue(
            Result.ok({ message: 'Verification email will be sent shortly' }),
        )

        const { authService } = await loadAuthService()
        const result = await authService.startEmailLink(9n, {
            email: 'phone-only@example.com',
            currentPassword: 'secret123',
        })

        expect(Result.isOk(result)).toBe(true)
        expect(consumeAuthThrottleMock).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                scope: 'link_email_target',
                limit: 3,
                windowMs: 60 * 60 * 1000,
            }),
            'phone-only@example.com',
        )
        expect(consumeAuthThrottleMock).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                scope: 'link_email_user',
                limit: 3,
                windowMs: 60 * 60 * 1000,
            }),
            '9',
        )
        expect(consumeAuthThrottleMock).toHaveBeenNthCalledWith(
            3,
            expect.objectContaining({
                scope: 'link_email_user_cooldown',
                limit: 1,
                windowMs: 60 * 1000,
            }),
            '9',
        )
        expect(sendLinkVerificationEmailMock).toHaveBeenCalledWith(9n, 'phone-only@example.com')
    })

    it('throttles email linking by target email', async () => {
        userRepositoryMock.findById.mockResolvedValue({
            id: 9n,
            email: null,
            password: 'stored-password-hash',
        })
        validatePasswordMock.mockResolvedValue(true)
        consumeAuthThrottleMock.mockResolvedValueOnce({ allowed: false, count: 4 })

        const { authService } = await loadAuthService()
        const result = await authService.startEmailLink(9n, {
            email: 'victim@example.com',
            currentPassword: 'secret123',
        })

        expect(Result.isError(result)).toBe(true)
        if (Result.isError(result)) {
            expect(result.error).toEqual({
                _tag: 'BadRequest',
                message: 'Too many verification attempts. Please try again later.',
            })
        }
        expect(sendLinkVerificationEmailMock).not.toHaveBeenCalled()
    })

    it('throttles email linking by user cooldown', async () => {
        userRepositoryMock.findById.mockResolvedValue({
            id: 9n,
            email: null,
            password: 'stored-password-hash',
        })
        validatePasswordMock.mockResolvedValue(true)
        consumeAuthThrottleMock
            .mockResolvedValueOnce({ allowed: true, count: 1 })
            .mockResolvedValueOnce({ allowed: true, count: 1 })
            .mockResolvedValueOnce({ allowed: false, count: 2 })

        const { authService } = await loadAuthService()
        const result = await authService.startEmailLink(9n, {
            email: 'victim@example.com',
            currentPassword: 'secret123',
        })

        expect(Result.isError(result)).toBe(true)
        if (Result.isError(result)) {
            expect(result.error).toEqual({
                _tag: 'BadRequest',
                message: 'Too many verification attempts. Please try again later.',
            })
        }
        expect(sendLinkVerificationEmailMock).not.toHaveBeenCalled()
    })

    it('returns unauthorized when login email is unknown', async () => {
        consumeAuthThrottleMock.mockResolvedValue({ allowed: true, count: 1 })
        userRepositoryMock.findByEmail.mockResolvedValue(undefined)

        const { authService } = await loadAuthService()
        const result = await authService.login(
            {
                email: 'missing@example.com',
                password: 'secret',
                token: '',
            },
            authMock as any,
            sessionMock as any,
            { ipAddress: '127.0.0.1' },
        )

        expect(Result.isError(result)).toBe(true)
        if (Result.isError(result)) {
            expect(result.error).toEqual({
                _tag: 'Unauthorized',
                message: 'Invalid email or password',
            })
        }
        expect(authMock.login).not.toHaveBeenCalled()
    })

    it('returns unauthorized when login password is invalid', async () => {
        consumeAuthThrottleMock.mockResolvedValue({ allowed: true, count: 1 })
        userRepositoryMock.findByEmail.mockResolvedValue({
            id: 7n,
            email: 'user@example.com',
            emailVerifiedAt: new Date('2026-05-30T00:00:00.000Z'),
            password: 'hashed-password',
            sessionToken: 'session-token',
        })
        validatePasswordMock.mockResolvedValue(false)

        const { authService } = await loadAuthService()
        const result = await authService.login(
            {
                email: 'user@example.com',
                password: 'wrong-secret',
                token: '',
            },
            authMock as any,
            sessionMock as any,
            { ipAddress: '127.0.0.1' },
        )

        expect(Result.isError(result)).toBe(true)
        if (Result.isError(result)) {
            expect(result.error).toEqual({
                _tag: 'Unauthorized',
                message: 'Invalid email or password',
            })
        }
        expect(authMock.login).not.toHaveBeenCalled()
    })

    // F2 (feat-066): a correct password for an unverified account used to answer 400 "Email
    // verification required": an oracle for "this account exists AND this password is right".
    // It answers exactly what a wrong password answers.
    describe('login of an unverified account (strict registration)', () => {
        const unverified = {
            id: 7n,
            email: 'user@example.com',
            emailVerifiedAt: null,
            password: 'hashed-password',
            sessionToken: 'session-token',
        }
        const credentials = { email: 'user@example.com', password: 'secret', token: '' }
        const login = async () => {
            const { authService } = await loadAuthService()
            return authService.login(credentials, authMock as any, sessionMock as any, {
                ipAddress: '127.0.0.1',
            })
        }
        // Lets the mail that is sent in the background run.
        const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

        it('answers the same 401 as a wrong password, so it reveals nothing', async () => {
            consumeAuthThrottleMock.mockResolvedValue({ allowed: true, count: 1 })
            userRepositoryMock.findByEmail.mockResolvedValue(unverified)
            validatePasswordMock.mockResolvedValue(false)
            const wrongPassword = await login()
            validatePasswordMock.mockResolvedValue(true)

            const unverifiedCorrect = await login()

            expect(Result.isError(unverifiedCorrect) && unverifiedCorrect.error._tag).toBe(
                'Unauthorized',
            )
            // The very same error value, not just the same kind.
            expect(Result.isError(wrongPassword) && wrongPassword.error).toEqual(
                Result.isError(unverifiedCorrect) && unverifiedCorrect.error,
            )
            expect(authMock.login).not.toHaveBeenCalled()
        })

        it('counts as a failed attempt: the per-account login budget is not reset', async () => {
            consumeAuthThrottleMock.mockResolvedValue({ allowed: true, count: 1 })
            userRepositoryMock.findByEmail.mockResolvedValue(unverified)
            validatePasswordMock.mockResolvedValue(true)

            await login()

            expect(resetAuthThrottleMock).not.toHaveBeenCalled()
        })

        it('sends the verification mail again in the background, once per interval per account', async () => {
            consumeAuthThrottleMock.mockResolvedValue({ allowed: true, count: 1 })
            userRepositoryMock.findByEmail.mockResolvedValue(unverified)
            validatePasswordMock.mockResolvedValue(true)

            await login()
            await settle()

            expect(consumeAuthThrottleMock).toHaveBeenCalledWith(
                throttlePolicies.loginUnverifiedResend,
                '7',
            )
            expect(sendVerificationEmailInBackgroundMock).toHaveBeenCalledWith(
                7n,
                'unverified login',
            )
        })

        it('does not send the mail again within the interval, and still answers 401', async () => {
            consumeAuthThrottleMock.mockImplementation((policy: { scope: string }) =>
                Promise.resolve({
                    allowed: policy.scope !== 'login_unverified_resend',
                    count: 1,
                }),
            )
            userRepositoryMock.findByEmail.mockResolvedValue(unverified)
            validatePasswordMock.mockResolvedValue(true)

            const result = await login()
            await settle()

            expect(Result.isError(result) && result.error._tag).toBe('Unauthorized')
            expect(sendVerificationEmailInBackgroundMock).not.toHaveBeenCalled()
        })

        it('answers 401 even when the resend cannot be arranged (Redis down)', async () => {
            consumeAuthThrottleMock.mockImplementation((policy: { scope: string }) =>
                policy.scope === 'login_unverified_resend'
                    ? Promise.reject(new Error('Command timed out'))
                    : Promise.resolve({ allowed: true, count: 1 }),
            )
            userRepositoryMock.findByEmail.mockResolvedValue(unverified)
            validatePasswordMock.mockResolvedValue(true)

            const result = await login()
            await settle()

            expect(Result.isError(result) && result.error._tag).toBe('Unauthorized')
            expect(sendVerificationEmailInBackgroundMock).not.toHaveBeenCalled()
        })

        it('does not wait for the mail: the answer does not depend on it', async () => {
            consumeAuthThrottleMock.mockResolvedValue({ allowed: true, count: 1 })
            userRepositoryMock.findByEmail.mockResolvedValue(unverified)
            validatePasswordMock.mockResolvedValue(true)
            sendVerificationEmailInBackgroundMock.mockReturnValue(new Promise(() => undefined))

            const result = await login()

            expect(Result.isError(result) && result.error._tag).toBe('Unauthorized')
        })

        it('sends nothing for a wrong password (the mail is for the owner, who knows it)', async () => {
            consumeAuthThrottleMock.mockResolvedValue({ allowed: true, count: 1 })
            userRepositoryMock.findByEmail.mockResolvedValue(unverified)
            validatePasswordMock.mockResolvedValue(false)

            await login()
            await settle()

            expect(sendVerificationEmailInBackgroundMock).not.toHaveBeenCalled()
        })
    })

    it('allows email password login for unverified users when strict registration is disabled', async () => {
        consumeAuthThrottleMock.mockResolvedValue({ allowed: true, count: 1 })
        process.env['AUTH_STRICT_REGISTRATION'] = 'false'
        userRepositoryMock.findByEmail.mockResolvedValue({
            id: 7n,
            email: 'user@example.com',
            emailVerifiedAt: null,
            password: 'hashed-password',
            sessionToken: 'session-token',
        })
        validatePasswordMock.mockResolvedValue(true)
        authMock.login.mockResolvedValue(true)
        generateWsTokenMock.mockResolvedValue('ws-token')

        const { authService } = await loadAuthService()
        const result = await authService.login(
            {
                email: 'user@example.com',
                password: 'secret',
                token: '',
            },
            authMock as any,
            sessionMock as any,
            { ipAddress: '127.0.0.1' },
        )

        expect(Result.isOk(result)).toBe(true)
        expect(authMock.login).toHaveBeenCalledWith('7', 'session-token')
    })

    it('renewSession logs the same user into a new session and returns its token', async () => {
        sessionMock.sessionInfo = {
            id: 'signed-in-session-id',
            data: { userId: '7', userToken: 'user-session-token', csrfToken: 'x'.repeat(43) },
        }
        authMock.login.mockImplementation(async () => {
            sessionMock.sessionInfo = {
                id: 'renewed-session-id',
                data: { csrfToken: ROTATED_LOGOUT_CSRF_TOKEN },
            }
            return true
        })

        const { authService } = await loadAuthService()
        const result = await authService.renewSession(authMock as any, sessionMock as any)

        expect(authMock.login).toHaveBeenCalledWith('7', 'user-session-token')
        expect(generateWsTokenMock).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'renewed-session-id' }),
            '7',
        )
        expect(Result.isOk(result) && result.value).toEqual({
            csrfToken: ROTATED_LOGOUT_CSRF_TOKEN,
            wsUrl: 'wss://example.com/ws',
            wsToken: expect.any(String),
        })
    })

    it('renewSession refuses an anonymous session', async () => {
        sessionMock.sessionInfo = { id: 'anonymous-session-id', data: {} }

        const { authService } = await loadAuthService()
        const result = await authService.renewSession(authMock as any, sessionMock as any)

        expect(Result.isError(result)).toBe(true)
        expect(authMock.login).not.toHaveBeenCalled()
    })

    // ADR 0002: a credential change rotates users.sessionToken; the renewed session is
    // issued under the new one, not under the token it replaces.
    it('renewSession issues the new session under a rotated user token', async () => {
        sessionMock.sessionInfo = {
            id: 'signed-in-session-id',
            data: { userId: '7', userToken: 'old-user-token', csrfToken: 'x'.repeat(43) },
        }
        authMock.login.mockImplementation(async () => {
            sessionMock.sessionInfo = {
                id: 'renewed-session-id',
                data: { csrfToken: ROTATED_LOGOUT_CSRF_TOKEN },
            }
            return true
        })

        const { authService } = await loadAuthService()
        const result = await authService.renewSession(
            authMock as any,
            sessionMock as any,
            'rotated-user-token',
        )

        expect(Result.isOk(result)).toBe(true)
        expect(authMock.login).toHaveBeenCalledWith('7', 'rotated-user-token')
    })

    describe('logoutAll rotates the sessionToken first (ADR 0002)', () => {
        it('rotates users.sessionToken before it deletes the records', async () => {
            const order: string[] = []
            userRepositoryMock.update.mockImplementation(async () => {
                order.push('rotate')
                return { id: 7n }
            })
            authMock.logoutAll.mockImplementation(async () => {
                order.push('delete records')
                return 2
            })

            const { authService } = await loadAuthService()
            await authService.logoutAll(authMock as any, sessionMock as any)

            expect(order).toEqual(['rotate', 'delete records'])
            expect(userRepositoryMock.update).toHaveBeenCalledWith(7n, {
                sessionToken: expect.stringMatching(/^[\w-]{21}$/),
            })
        })

        it('fails without touching Redis when the rotation fails', async () => {
            userRepositoryMock.update.mockRejectedValue(new Error('db down'))

            const { authService } = await loadAuthService()
            const result = await authService.logoutAll(authMock as any, sessionMock as any)

            expect(Result.isError(result)).toBe(true)
            expect(authMock.logoutAll).not.toHaveBeenCalled()
            expect(securityNotice).not.toHaveBeenCalled()
        })

        it('reports an error when the record cleanup fails, but the rotation already happened', async () => {
            userRepositoryMock.update.mockResolvedValue({ id: 7n })
            authMock.logoutAll.mockRejectedValue(new Error('redis down'))

            const { authService } = await loadAuthService()
            const result = await authService.logoutAll(authMock as any, sessionMock as any)

            expect(Result.isError(result)).toBe(true)
            expect(userRepositoryMock.update).toHaveBeenCalledTimes(1)
        })
    })

    it('returns the rotated CSRF token after logout mutates the session', async () => {
        authMock.logout.mockImplementation(async () => {
            sessionMock.sessionInfo = {
                id: 'anonymous-session-id',
                data: { csrfToken: ROTATED_LOGOUT_CSRF_TOKEN },
            }
            return true
        })

        const { authService } = await loadAuthService()
        const result = await authService.logout(authMock as any, sessionMock as any)

        expect(Result.isOk(result)).toBe(true)
        if (Result.isOk(result)) {
            expect(result.value).toEqual({
                status: 'success',
                csrfToken: ROTATED_LOGOUT_CSRF_TOKEN,
            })
        }
    })

    it('returns the rotated CSRF token after logoutAll mutates the session', async () => {
        userRepositoryMock.update.mockResolvedValue({ id: 7n })
        authMock.logoutAll.mockImplementation(async () => {
            sessionMock.sessionInfo = {
                id: 'anonymous-session-id',
                data: { csrfToken: ROTATED_LOGOUT_ALL_CSRF_TOKEN },
            }
            return 3
        })

        const { authService } = await loadAuthService()
        const result = await authService.logoutAll(authMock as any, sessionMock as any)

        expect(Result.isOk(result)).toBe(true)
        if (Result.isOk(result)) {
            expect(result.value).toEqual({
                status: 'success',
                deletedCount: 3,
                csrfToken: ROTATED_LOGOUT_ALL_CSRF_TOKEN,
            })
        }
        // Security push after a successful logout-all (code-issues item 72).
        expect(securityNotice).toHaveBeenCalledWith(7n, 'logout_all')
    })

    it('returns not found when changePassword user is missing', async () => {
        userRepositoryMock.findById.mockResolvedValue(undefined)

        const { authService } = await loadAuthService()
        const result = await authService.changePassword(7n, {
            currentPassword: 'old-secret',
            newPassword: 'new-secret',
        })

        expect(Result.isError(result)).toBe(true)
        if (Result.isError(result)) {
            expect(result.error).toEqual({
                _tag: 'NotFound',
                resource: 'User',
                message: 'User not found',
            })
        }
        expect(userRepositoryMock.update).not.toHaveBeenCalled()
    })

    describe('changePassword rotates the sessionToken (ADR 0002)', () => {
        const arrangeUser = (): void => {
            userRepositoryMock.findById.mockResolvedValue({
                id: 7n,
                password: 'stored-hash',
                sessionToken: 'previous-session-token',
            })
            validatePasswordMock.mockResolvedValue(true)
            hashPasswordMock.mockResolvedValue('new-hash')
            userRepositoryMock.changePasswordIfCurrent.mockResolvedValue({ id: 7n })
            destroyAllSessionsMock.mockResolvedValue(2)
        }
        const change = async () => {
            const { authService } = await loadAuthService()
            return authService.changePassword(7n, {
                currentPassword: 'old-secret',
                newPassword: 'new-secret',
            })
        }

        it('writes the new hash and a rotated token in one conditional update', async () => {
            arrangeUser()

            const result = await change()

            expect(userRepositoryMock.changePasswordIfCurrent).toHaveBeenCalledWith(
                7n,
                'stored-hash',
                { password: 'new-hash', sessionToken: expect.stringMatching(/^[\w-]{21}$/) },
            )
            expect(userRepositoryMock.update).not.toHaveBeenCalled()
            expect(Result.isOk(result)).toBe(true)
            if (Result.isOk(result)) {
                const call = userRepositoryMock.changePasswordIfCurrent.mock.calls[0]
                expect(result.value.sessionToken).toBe(call?.[2].sessionToken)
                expect(result.value.sessionToken).not.toBe('previous-session-token')
            }
            expect(securityNotice).toHaveBeenCalledWith(7n, 'password_changed')
        })

        it('deletes the records of the previous token', async () => {
            arrangeUser()

            await change()

            expect(destroyAllSessionsMock).toHaveBeenCalledWith('previous-session-token')
        })

        it('still succeeds when the Redis cleanup fails: the rotation is the revocation', async () => {
            arrangeUser()
            destroyAllSessionsMock.mockRejectedValue(new Error('redis down'))

            const result = await change()

            expect(destroyAllSessionsMock).toHaveBeenCalledWith('previous-session-token')
            expect(Result.isOk(result)).toBe(true)
            expect(securityNotice).toHaveBeenCalledWith(7n, 'password_changed')
        })

        it('answers a conflict when another request changed the password first', async () => {
            arrangeUser()
            userRepositoryMock.changePasswordIfCurrent.mockResolvedValue(undefined)

            const result = await change()

            expect(Result.isError(result)).toBe(true)
            if (Result.isError(result)) expect(result.error._tag).toBe('Conflict')
            expect(destroyAllSessionsMock).not.toHaveBeenCalled()
            expect(securityNotice).not.toHaveBeenCalled()
        })

        it('does not touch the password or sessions when the current password is wrong', async () => {
            arrangeUser()
            validatePasswordMock.mockResolvedValue(false)

            const result = await change()

            expect(Result.isError(result)).toBe(true)
            expect(userRepositoryMock.changePasswordIfCurrent).not.toHaveBeenCalled()
            expect(destroyAllSessionsMock).not.toHaveBeenCalled()
        })
    })
})

describe('auth throttle fail-closed (email link)', () => {
    it('rejects email linking without sending the verification email', async () => {
        consumeAuthThrottleMock.mockReset()
        consumeAuthThrottleMock.mockRejectedValue(new Error('redis down'))
        userRepositoryMock.findById.mockResolvedValue({
            id: 9n,
            email: null,
            password: 'stored-password-hash',
        })
        validatePasswordMock.mockResolvedValue(true)

        const { authService } = await loadAuthService()
        const result = await authService.startEmailLink(9n, {
            email: 'phone-only@example.com',
            currentPassword: 'secret123',
        })

        expect(Result.isError(result)).toBe(true)
        expect(consumeAuthThrottleMock).toHaveBeenCalledTimes(1)
        expect(sendLinkVerificationEmailMock).not.toHaveBeenCalled()
    })
})

describe('authService while Redis is unavailable', () => {
    const LOGIN_INPUT = { email: 'user@example.com', password: 'secret', token: '' }
    const LOGIN_CONTEXT = { ipAddress: '127.0.0.1' }

    const arrangeLogin = (): void => {
        userRepositoryMock.findByEmail.mockResolvedValue({
            id: 7n,
            email: 'user@example.com',
            emailVerifiedAt: new Date('2026-05-30T00:00:00.000Z'),
            password: 'hashed-password',
            sessionToken: 'session-token',
        })
        validatePasswordMock.mockResolvedValue(true)
    }

    /** What the controller answers for this AppError (status, headers, body). */
    const toResponse = async (error: unknown) => {
        const { mapControllerError } = await import('#app/controllers/shared/controller-error.js')
        const headers = new Map<string, string>()
        const responseData = {
            status: 200,
            setHeader: (name: string, value: string) => {
                headers.set(name, value)
            },
        }
        const payload = mapControllerError({ responseData } as never, error as never)
        return { status: responseData.status, headers, payload }
    }

    const operations: [
        string,
        () => void,
        (s: Awaited<ReturnType<typeof loadAuthService>>['authService']) => Promise<unknown>,
    ][] = [
        [
            'login',
            () => {
                arrangeLogin()
            },
            (s) => s.login(LOGIN_INPUT, authMock as any, sessionMock as any, LOGIN_CONTEXT),
        ],
        [
            'WS token generation during login',
            () => {
                arrangeLogin()
                authMock.login.mockResolvedValue(true)
            },
            (s) => s.login(LOGIN_INPUT, authMock as any, sessionMock as any, LOGIN_CONTEXT),
        ],
        ['logout', () => {}, (s) => s.logout(authMock as any, sessionMock as any)],
        [
            'logoutAll',
            () => {
                userRepositoryMock.update.mockResolvedValue({ id: 7n })
            },
            (s) => s.logoutAll(authMock as any, sessionMock as any),
        ],
    ]

    const failWith = (name: string, err: Error): void => {
        if (name.startsWith('WS token')) generateWsTokenMock.mockRejectedValue(err)
        else if (name === 'login') authMock.login.mockRejectedValue(err)
        else if (name === 'logout') authMock.logout.mockRejectedValue(err)
        else authMock.logoutAll.mockRejectedValue(err)
    }

    it.each(operations)(
        '%s: RedisUnavailableError → 503 service_unavailable with Retry-After',
        async (name, arrange, run) => {
            const { RedisUnavailableError } =
                await import('#vendor/utils/network/errors/redis-unavailable-error.js')
            arrange()
            failWith(
                name,
                new RedisUnavailableError('Redis command failed', {
                    cause: new Error('Command timed out'),
                }),
            )
            const { authService } = await loadAuthService()

            const result = (await run(authService)) as Result<unknown, unknown>

            expect(Result.isError(result)).toBe(true)
            if (!Result.isError(result)) return
            const response = await toResponse(result.error)
            expect(response.status).toBe(503)
            expect(response.headers.get('Retry-After')).toBe('1')
            expect(response.payload).toEqual({
                status: 'error',
                code: 'service_unavailable',
                message: 'Service temporarily unavailable. Try again later.',
            })
            expect(JSON.stringify(response.payload)).not.toMatch(/timed out|Failed to/)
            // A partial logoutAll never reports success or a deletedCount.
            expect(JSON.stringify(response.payload)).not.toContain('deletedCount')
        },
    )

    it.each(operations)('%s: any other error → 500 as before', async (name, arrange, run) => {
        arrange()
        failWith(name, new Error('boom'))
        const { authService } = await loadAuthService()

        const result = (await run(authService)) as Result<unknown, unknown>

        expect(Result.isError(result)).toBe(true)
        if (!Result.isError(result)) return
        const response = await toResponse(result.error)
        expect(response.status).toBe(500)
        expect(response.headers.has('Retry-After')).toBe(false)
    })
})
