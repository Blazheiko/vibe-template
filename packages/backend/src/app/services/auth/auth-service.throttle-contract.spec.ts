import { Result } from 'better-result'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { classifyError } from '#vendor/utils/network/errors/classify-error.js'
import {
    appErrorCode,
    appErrorMessage,
    appErrorStatus,
    type AppError,
} from '#app/services/shared/errors.js'
import type { authService } from './auth-service.js'

// feat-069 (G1): the throttle steps of authService as a table, before they are folded into one
// `enforceThrottle()` helper (H1). Per step: which counter is consumed (scope + key), in what
// order, what the caller gets when the counter is spent ("blocked") and when Redis does not
// answer ("unavailable"), and that nothing downstream ran. The helper must not change a row.

const userRepositoryMock = {
    findByEmail: vi.fn(),
    findByPhone: vi.fn(),
    findById: vi.fn(),
    emailExistsForOtherUser: vi.fn(),
    phoneExistsForOtherUser: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    changePasswordIfCurrent: vi.fn(),
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
const authMock = { login: vi.fn(), logout: vi.fn(), logoutAll: vi.fn(), getUserId: vi.fn() }
const sessionMock = { sessionInfo: { id: 'session-id', data: {} }, destroySession: vi.fn() }
const loggerMock = { warn: vi.fn(), info: vi.fn(), error: vi.fn() }
const hashPasswordMock = vi.fn()
const validatePasswordMock = vi.fn()
const consumeAuthThrottleMock = vi.fn()
const issueVerificationCodeMock = vi.fn()
const sendLinkVerificationEmailMock = vi.fn()
const destroyAllSessionsMock = vi.fn()

vi.mock('#app/repositories/index.js', () => ({
    userRepository: userRepositoryMock,
    smsAuthChallengeRepository: smsAuthChallengeRepositoryMock,
    withTransaction: <T>(work: (tx: unknown) => Promise<T>): Promise<T> => work({}),
}))
vi.mock('#app/transformers/index.js', () => ({ userTransformer: { serialize: vi.fn() } }))
vi.mock('#vendor/utils/session/redis-session-storage.js', () => ({
    destroyAllSessions: destroyAllSessionsMock,
}))
vi.mock('metautil', () => ({
    hashPassword: hashPasswordMock,
    validatePassword: validatePasswordMock,
}))
vi.mock('#app/services/auth/generate-ws-token-service.js', () => ({ generateWsToken: vi.fn() }))
vi.mock('#app/services/communication/get-ws-url-service.js', () => ({ getWsUrl: vi.fn() }))
vi.mock('#app/services/notifications/user-notification-service.js', () => ({
    userNotificationService: { security: vi.fn(), supportReply: vi.fn() },
}))
vi.mock('#app/services/auth/email-verification-service.js', () => ({
    emailVerificationService: {
        sendVerificationEmailAfterRegistration: vi.fn(),
        sendLinkVerificationEmail: sendLinkVerificationEmailMock,
        sendVerificationEmailInBackground: vi.fn(),
    },
}))
vi.mock('#app/services/auth/sms-verification-provider.js', () => ({
    smsVerificationProvider: { issueVerificationCode: issueVerificationCodeMock },
}))
vi.mock('#app/services/auth/auth-throttle-service.js', () => ({
    consumeAuthThrottle: consumeAuthThrottleMock,
    resetAuthThrottle: vi.fn(),
}))
vi.mock('#logger', () => ({ default: loggerMock }))

const originalEnv = { ...process.env }

beforeEach(() => {
    process.env['AUTH_PHONE_ENABLED'] = 'true'
    process.env['APP_KEY'] = 'a'.repeat(32)
    process.env['FRONTEND_URL'] = 'https://app.example.com'
    process.env['APP_URL'] = 'https://app.example.com'
    validatePasswordMock.mockResolvedValue(true)
    hashPasswordMock.mockResolvedValue('hash')
    userRepositoryMock.findById.mockResolvedValue({
        id: 7n,
        email: null,
        phone: null,
        password: 'stored-hash',
    })
})

afterEach(() => {
    vi.resetModules()
    vi.resetAllMocks()
    for (const key of Object.keys(process.env)) {
        if (!(key in originalEnv)) delete process.env[key]
    }
    Object.assign(process.env, originalEnv)
    consumeAuthThrottleMock.mockReset()
})

type Service = typeof authService

const IP = { ipAddress: '203.0.113.9' }
const PHONE = '+380501234567'
const TOO_MANY_VERIFICATIONS = 'Too many verification attempts. Please try again later.'
const TOO_MANY_REGISTRATIONS = 'Too many registration attempts. Please try again later.'

interface Row {
    method: string
    call: (service: Service) => Promise<unknown>
    /** Counters consumed up to and including the one under test: [scope, key]. */
    consumed: readonly (readonly [string, string])[]
    /** What the caller gets when the last counter is spent. */
    blocked: { status: number; code: string; message: string }
    /** What the caller gets when Redis fails on the last counter. */
}

const login = (identifier: string) => (service: Service) =>
    service.login({ identifier, password: 'secret' }, authMock as never, sessionMock as never, IP)
const INVALID = { status: 401, code: 'unauthorized', message: 'Invalid email or password' }
const badRequest = (message: string) => ({ status: 400, code: 'bad_request', message })

const ROWS: readonly Row[] = [
    {
        method: 'registerByEmail · ip',
        call: (s) =>
            s.registerByEmail(
                {
                    name: 'Jane',
                    email: ' User@Example.com ',
                    password: 'secret',
                    token: '',
                },
                authMock as never,
                sessionMock as never,
                loggerMock as never,
                IP,
            ),
        consumed: [['register_email_ip', '203.0.113.9']],
        blocked: badRequest(TOO_MANY_REGISTRATIONS),
    },
    {
        method: 'registerByEmail · identifier',
        call: (s) =>
            s.registerByEmail(
                {
                    name: 'Jane',
                    email: ' User@Example.com ',
                    password: 'secret',
                    token: '',
                },
                authMock as never,
                sessionMock as never,
                loggerMock as never,
                IP,
            ),
        consumed: [
            ['register_email_ip', '203.0.113.9'],
            ['register_email_identifier', 'user@example.com'],
        ],
        blocked: badRequest(TOO_MANY_REGISTRATIONS),
    },
    {
        method: 'startPhoneRegistration · ip',
        call: (s) => s.startPhoneRegistration({ phone: PHONE }, { ...IP, sessionId: 's' }),
        consumed: [['register_phone_ip', '203.0.113.9']],
        blocked: badRequest(TOO_MANY_VERIFICATIONS),
    },
    {
        method: 'startPhoneRegistration · phone',
        call: (s) => s.startPhoneRegistration({ phone: PHONE }, { ...IP, sessionId: 's' }),
        consumed: [
            ['register_phone_ip', '203.0.113.9'],
            ['sms_send_phone', PHONE],
        ],
        blocked: badRequest(TOO_MANY_VERIFICATIONS),
    },
    {
        method: 'confirmPhoneRegistration · ip',
        call: (s) => s.confirmPhoneRegistration({ challengeId: 'c', code: '123456' }, IP),
        consumed: [['confirm_phone_ip', '203.0.113.9']],
        blocked: badRequest(TOO_MANY_VERIFICATIONS),
    },
    {
        method: 'startPhoneLink · ip',
        call: (s) =>
            s.startPhoneLink(
                7n,
                { phone: PHONE, currentPassword: 'secret' },
                {
                    ...IP,
                    sessionId: 's',
                },
            ),
        consumed: [['link_phone_ip', '203.0.113.9']],
        blocked: badRequest(TOO_MANY_VERIFICATIONS),
    },
    {
        method: 'startPhoneLink · phone',
        call: (s) =>
            s.startPhoneLink(
                7n,
                { phone: PHONE, currentPassword: 'secret' },
                {
                    ...IP,
                    sessionId: 's',
                },
            ),
        consumed: [
            ['link_phone_ip', '203.0.113.9'],
            ['sms_send_phone', PHONE],
        ],
        blocked: badRequest(TOO_MANY_VERIFICATIONS),
    },
    {
        method: 'confirmPhoneLink · ip',
        call: (s) =>
            s.confirmPhoneLink(
                7n,
                { challengeId: 'c', code: '123456' },
                {
                    ...IP,
                    sessionId: 's',
                },
            ),
        consumed: [['confirm_link_phone_ip', '203.0.113.9']],
        blocked: badRequest(TOO_MANY_VERIFICATIONS),
    },
    {
        method: 'startEmailLink · target',
        call: (s) =>
            s.startEmailLink(7n, {
                email: ' New@Example.com ',
                currentPassword: 'secret',
            }),
        consumed: [['link_email_target', 'new@example.com']],
        blocked: badRequest(TOO_MANY_VERIFICATIONS),
    },
    {
        method: 'startEmailLink · user',
        call: (s) =>
            s.startEmailLink(7n, {
                email: ' New@Example.com ',
                currentPassword: 'secret',
            }),
        consumed: [
            ['link_email_target', 'new@example.com'],
            ['link_email_user', '7'],
        ],
        blocked: badRequest(TOO_MANY_VERIFICATIONS),
    },
    {
        method: 'startEmailLink · cooldown',
        call: (s) =>
            s.startEmailLink(7n, {
                email: ' New@Example.com ',
                currentPassword: 'secret',
            }),
        consumed: [
            ['link_email_target', 'new@example.com'],
            ['link_email_user', '7'],
            ['link_email_user_cooldown', '7'],
        ],
        blocked: badRequest(TOO_MANY_VERIFICATIONS),
    },
    {
        method: 'login · ip',
        call: login('user@example.com'),
        consumed: [['login_ip', '203.0.113.9']],
        blocked: INVALID,
    },
    {
        method: 'login · identifier (email)',
        call: login(' User@Example.com '),
        consumed: [
            ['login_ip', '203.0.113.9'],
            ['login_identifier', 'user@example.com'],
        ],
        blocked: INVALID,
    },
    {
        method: 'login · identifier (phone)',
        call: login(PHONE),
        consumed: [
            ['login_ip', '203.0.113.9'],
            ['login_identifier', PHONE],
        ],
        blocked: INVALID,
    },
    {
        method: 'changePassword · user',
        call: (s) => s.changePassword(7n, { currentPassword: 'old', newPassword: 'new-password' }),
        consumed: [['change_password_user', '7']],
        blocked: badRequest('Too many password change attempts. Please try again later.'),
    },
]

function describeError(error: AppError): { status: number; code: string; message: string } {
    return {
        status: appErrorStatus(error),
        code: appErrorCode(error),
        message: appErrorMessage(error),
    }
}

/** Every counter allowed, except the last one of the row, which behaves as `mode` says. */
function arrange(row: Row, mode: 'blocked' | 'unavailable'): void {
    const target = row.consumed.at(-1)![0]
    consumeAuthThrottleMock.mockImplementation((policy: { scope: string }) => {
        if (policy.scope !== target) return Promise.resolve({ allowed: true, count: 1 })
        return mode === 'blocked'
            ? Promise.resolve({ allowed: false, count: 999 })
            : Promise.reject(new Error('redis down'))
    })
}

function untouchedDownstream(): void {
    expect(userRepositoryMock.create).not.toHaveBeenCalled()
    expect(userRepositoryMock.findByEmail).not.toHaveBeenCalled()
    expect(userRepositoryMock.findByPhone).not.toHaveBeenCalled()
    expect(userRepositoryMock.emailExistsForOtherUser).not.toHaveBeenCalled()
    expect(userRepositoryMock.phoneExistsForOtherUser).not.toHaveBeenCalled()
    expect(smsAuthChallengeRepositoryMock.create).not.toHaveBeenCalled()
    expect(smsAuthChallengeRepositoryMock.findById).not.toHaveBeenCalled()
    expect(issueVerificationCodeMock).not.toHaveBeenCalled()
    expect(sendLinkVerificationEmailMock).not.toHaveBeenCalled()
    expect(userRepositoryMock.changePasswordIfCurrent).not.toHaveBeenCalled()
    expect(destroyAllSessionsMock).not.toHaveBeenCalled()
    expect(authMock.login).not.toHaveBeenCalled()
}

describe.each(ROWS)('authService throttle: $method', (row) => {
    it('consumes the counters in this order, with these keys', async () => {
        arrange(row, 'blocked')
        const { authService } = await import('./auth-service.js')
        await row.call(authService)
        expect(
            consumeAuthThrottleMock.mock.calls.map(([policy, key]) => [
                (policy as { scope: string }).scope,
                key,
            ]),
        ).toEqual(row.consumed)
    })

    it('answers a spent counter with the stated error and does nothing further', async () => {
        arrange(row, 'blocked')
        const { authService } = await import('./auth-service.js')
        const result = (await row.call(authService)) as Result<unknown, AppError>
        expect(Result.isError(result)).toBe(true)
        if (Result.isError(result)) expect(describeError(result.error)).toEqual(row.blocked)
        untouchedDownstream()
    })

    // ADR 0004: a Redis failure is not an AppError; the call rejects (fail closed) and the
    // transport answers. Nothing downstream may run on its behalf.
    it('fails closed when Redis does not answer: the call rejects, nothing downstream runs', async () => {
        arrange(row, 'unavailable')
        const { authService } = await import('./auth-service.js')
        await expect(row.call(authService)).rejects.toThrow()
        untouchedDownstream()
    })

    it('a Redis outage becomes 503 at the transport, not 500', async () => {
        const target = row.consumed.at(-1)![0]
        consumeAuthThrottleMock.mockImplementation((policy: { scope: string }) =>
            policy.scope === target
                ? Promise.reject(Object.assign(new Error('Command timed out'), {}))
                : Promise.resolve({ allowed: true, count: 1 }),
        )
        const { authService } = await import('./auth-service.js')
        const thrown = await row.call(authService).then(
            () => undefined,
            (err: unknown) => err,
        )
        expect(classifyError(thrown)).toMatchObject({ status: 503, code: 'service_unavailable' })
    })
})
