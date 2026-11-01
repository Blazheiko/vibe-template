import { Result } from 'better-result'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    appErrorCode,
    appErrorMessage,
    appErrorStatus,
    type AppError,
} from '#app/services/shared/errors.js'
import type { passwordResetService } from './password-reset-service.js'

// feat-069 (G1): the throttle steps of passwordResetService as a table, before they are folded
// into `enforceThrottle()` (H1). Same reading as auth-service.throttle-contract.spec.ts. The
// forgot-password step is the odd one out and is pinned on its own: it never fails, whatever
// the counters say, so the answer does not tell whether an address exists.

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
const emailServiceMock = { send: vi.fn() }
const consumeAuthThrottleMock = vi.fn()
const issueVerificationCodeMock = vi.fn()
const destroyAllSessionsMock = vi.fn()
const hashPasswordMock = vi.fn()
const loggerMock = { warn: vi.fn(), error: vi.fn(), info: vi.fn() }

vi.mock('#app/repositories/index.js', () => ({
    userRepository: userRepositoryMock,
    passwordResetRepository: passwordResetRepositoryMock,
    smsAuthChallengeRepository: smsAuthChallengeRepositoryMock,
    withTransaction: <T>(work: (tx: unknown) => Promise<T>): Promise<T> => work({}),
}))
vi.mock('#app/services/notifications/email-service.js', () => ({ emailService: emailServiceMock }))
vi.mock('#vendor/utils/session/redis-session-storage.js', () => ({
    destroyAllSessions: destroyAllSessionsMock,
}))
vi.mock('#app/services/auth/auth-throttle-service.js', () => ({
    consumeAuthThrottle: consumeAuthThrottleMock,
    resetAuthThrottle: vi.fn(),
}))
vi.mock('#app/services/auth/sms-verification-provider.js', () => ({
    smsVerificationProvider: { issueVerificationCode: issueVerificationCodeMock },
}))
vi.mock('metautil', () => ({ hashPassword: hashPasswordMock }))
vi.mock('#logger', () => ({ default: loggerMock }))

const originalEnv = { ...process.env }

beforeEach(() => {
    process.env['AUTH_PHONE_ENABLED'] = 'true'
    process.env['APP_KEY'] = 'a'.repeat(32)
    process.env['FRONTEND_URL'] = 'https://app.example.com'
    process.env['APP_URL'] = 'https://app.example.com'
})

afterEach(() => {
    vi.resetModules()
    vi.resetAllMocks()
    consumeAuthThrottleMock.mockReset()
    for (const key of Object.keys(process.env)) {
        if (!(key in originalEnv)) delete process.env[key]
    }
    Object.assign(process.env, originalEnv)
})

type Service = typeof passwordResetService

const IP = { ipAddress: '203.0.113.9' }
const PHONE = '+380501234567'
const TOO_MANY_VERIFICATIONS = 'Too many verification attempts. Please try again later.'
const GENERIC = 'If an account with that email exists, a reset link will be sent shortly.'

interface Row {
    method: string
    call: (service: Service) => Promise<unknown>
    consumed: readonly (readonly [string, string])[]
    blocked: { status: number; code: string; message: string }
    unavailable: string
}
const badRequest = (message: string) => ({ status: 400, code: 'bad_request', message })

const ROWS: readonly Row[] = [
    {
        method: 'startPhonePasswordReset · ip',
        call: (s) => s.startPhonePasswordReset(PHONE, undefined, { ...IP, sessionId: 's' }),
        consumed: [['reset_phone_ip', '203.0.113.9']],
        blocked: badRequest(TOO_MANY_VERIFICATIONS),
        unavailable: 'Failed to enforce phone reset IP throttle',
    },
    {
        method: 'startPhonePasswordReset · phone',
        call: (s) => s.startPhonePasswordReset(PHONE, undefined, { ...IP, sessionId: 's' }),
        consumed: [
            ['reset_phone_ip', '203.0.113.9'],
            ['sms_send_phone', PHONE],
        ],
        blocked: badRequest(TOO_MANY_VERIFICATIONS),
        unavailable: 'Failed to enforce phone reset identifier throttle',
    },
    {
        method: 'resetPassword · ip',
        call: (s) => s.resetPassword('tok', 'new-password', 'new-password', IP),
        consumed: [['reset_password_ip', '203.0.113.9']],
        blocked: badRequest('Too many password reset attempts. Please try again later.'),
        unavailable: 'Failed to enforce reset password throttle',
    },
    {
        method: 'completePhonePasswordReset · ip',
        call: (s) =>
            s.completePhonePasswordReset('c', '123456', 'new-password', 'new-password', IP),
        consumed: [['confirm_reset_phone_ip', '203.0.113.9']],
        blocked: badRequest(TOO_MANY_VERIFICATIONS),
        unavailable: 'Failed to enforce phone reset confirmation IP throttle',
    },
]

function describeError(error: AppError): { status: number; code: string; message: string } {
    return {
        status: appErrorStatus(error),
        code: appErrorCode(error),
        message: appErrorMessage(error),
    }
}

function arrange(target: string, mode: 'blocked' | 'unavailable' | 'timeout'): void {
    consumeAuthThrottleMock.mockImplementation((policy: { scope: string }) => {
        if (policy.scope !== target) return Promise.resolve({ allowed: true, count: 1 })
        if (mode === 'blocked') return Promise.resolve({ allowed: false, count: 999 })
        return Promise.reject(new Error(mode === 'timeout' ? 'Command timed out' : 'redis down'))
    })
}

function untouchedDownstream(): void {
    expect(userRepositoryMock.findByEmail).not.toHaveBeenCalled()
    expect(userRepositoryMock.findByPhone).not.toHaveBeenCalled()
    expect(userRepositoryMock.update).not.toHaveBeenCalled()
    expect(passwordResetRepositoryMock.findByTokenHash).not.toHaveBeenCalled()
    expect(passwordResetRepositoryMock.create).not.toHaveBeenCalled()
    expect(smsAuthChallengeRepositoryMock.findById).not.toHaveBeenCalled()
    expect(smsAuthChallengeRepositoryMock.create).not.toHaveBeenCalled()
    expect(issueVerificationCodeMock).not.toHaveBeenCalled()
    expect(emailServiceMock.send).not.toHaveBeenCalled()
    expect(destroyAllSessionsMock).not.toHaveBeenCalled()
    expect(hashPasswordMock).not.toHaveBeenCalled()
}

describe.each(ROWS)('passwordResetService throttle: $method', (row) => {
    const target = row.consumed.at(-1)![0]

    it('consumes the counters in this order, with these keys', async () => {
        arrange(target, 'blocked')
        const { passwordResetService } = await import('./password-reset-service.js')
        await row.call(passwordResetService)
        expect(
            consumeAuthThrottleMock.mock.calls.map(([policy, key]) => [
                (policy as { scope: string }).scope,
                key,
            ]),
        ).toEqual(row.consumed)
    })

    it('answers a spent counter with the stated error and does nothing further', async () => {
        arrange(target, 'blocked')
        const { passwordResetService } = await import('./password-reset-service.js')
        const result = (await row.call(passwordResetService)) as Result<unknown, AppError>
        expect(Result.isError(result)).toBe(true)
        if (Result.isError(result)) expect(describeError(result.error)).toEqual(row.blocked)
        untouchedDownstream()
    })

    it('fails closed with a 500 and its own message when Redis does not answer', async () => {
        arrange(target, 'unavailable')
        const { passwordResetService } = await import('./password-reset-service.js')
        const result = (await row.call(passwordResetService)) as Result<unknown, AppError>
        expect(Result.isError(result)).toBe(true)
        if (Result.isError(result)) {
            expect(describeError(result.error)).toEqual({
                status: 500,
                code: 'internal_error',
                message: row.unavailable,
            })
        }
        untouchedDownstream()
    })

    it('answers 503 and not 500 when Redis is unreachable', async () => {
        arrange(target, 'timeout')
        const { passwordResetService } = await import('./password-reset-service.js')
        const result = (await row.call(passwordResetService)) as Result<unknown, AppError>
        expect(Result.isError(result)).toBe(true)
        if (Result.isError(result)) {
            expect(describeError(result.error)).toEqual({
                status: 503,
                code: 'service_unavailable',
                message: 'Service temporarily unavailable. Try again later.',
            })
        }
    })
})

describe('passwordResetService throttle: requestPasswordReset', () => {
    const consumed = (): unknown[] =>
        consumeAuthThrottleMock.mock.calls.map(([policy, key]) => [
            (policy as { scope: string }).scope,
            key,
        ])

    it('consumes the IP counter, then the e-mail counter on the normalised address', async () => {
        arrange('none', 'blocked')
        userRepositoryMock.findByEmail.mockResolvedValue(undefined)
        const { passwordResetService } = await import('./password-reset-service.js')
        const result = await passwordResetService.requestPasswordReset(' User@Example.com ', IP)
        expect(consumed()).toEqual([
            ['forgot_password_ip', '203.0.113.9'],
            ['forgot_password_email', 'user@example.com'],
        ])
        expect(Result.isOk(result) && result.value).toEqual({ message: GENERIC })
        expect(userRepositoryMock.findByEmail).toHaveBeenCalledWith('user@example.com')
    })

    it('does not look at the address when the IP counter is spent', async () => {
        arrange('forgot_password_ip', 'blocked')
        const { passwordResetService } = await import('./password-reset-service.js')
        const result = await passwordResetService.requestPasswordReset('user@example.com', IP)
        expect(consumed()).toEqual([['forgot_password_ip', '203.0.113.9']])
        expect(Result.isOk(result) && result.value).toEqual({ message: GENERIC })
        expect(userRepositoryMock.findByEmail).not.toHaveBeenCalled()
    })

    it('does not look at the address when the e-mail counter is spent', async () => {
        arrange('forgot_password_email', 'blocked')
        const { passwordResetService } = await import('./password-reset-service.js')
        const result = await passwordResetService.requestPasswordReset('user@example.com', IP)
        expect(Result.isOk(result) && result.value).toEqual({ message: GENERIC })
        expect(userRepositoryMock.findByEmail).not.toHaveBeenCalled()
    })

    it('answers the same generic text when Redis fails, and only logs it', async () => {
        arrange('forgot_password_ip', 'unavailable')
        const { passwordResetService } = await import('./password-reset-service.js')
        const result = await passwordResetService.requestPasswordReset('user@example.com', IP)
        expect(Result.isOk(result) && result.value).toEqual({ message: GENERIC })
        expect(loggerMock.warn).toHaveBeenCalledWith(
            expect.objectContaining({ err: expect.anything() }),
            'Forgot password throttle unavailable',
        )
        expect(userRepositoryMock.findByEmail).not.toHaveBeenCalled()
    })

    it('consumes only the IP counter for an empty address', async () => {
        arrange('none', 'blocked')
        const { passwordResetService } = await import('./password-reset-service.js')
        const result = await passwordResetService.requestPasswordReset('   ', IP)
        expect(consumed()).toEqual([['forgot_password_ip', '203.0.113.9']])
        expect(Result.isOk(result) && result.value).toEqual({ message: GENERIC })
        expect(userRepositoryMock.findByEmail).not.toHaveBeenCalled()
    })
})
