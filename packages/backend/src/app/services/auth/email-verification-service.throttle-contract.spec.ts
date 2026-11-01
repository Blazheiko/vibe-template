import { Result } from 'better-result'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
    appErrorCode,
    appErrorMessage,
    appErrorStatus,
    type AppError,
} from '#app/services/shared/errors.js'
import type { emailVerificationService } from './email-verification-service.js'

// feat-069 (G1): the throttle steps of emailVerificationService as a table, before they are
// folded into `enforceThrottle()` (H1). Same reading as auth-service.throttle-contract.spec.ts.

const userRepositoryMock = { findById: vi.fn(), findByEmail: vi.fn(), update: vi.fn() }
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
const emailServiceMock = { send: vi.fn() }
const consumeAuthThrottleMock = vi.fn()

vi.mock('#app/repositories/index.js', () => ({
    userRepository: userRepositoryMock,
    emailVerificationRepository: emailVerificationRepositoryMock,
    emailLinkVerificationRepository: emailLinkVerificationRepositoryMock,
    withTransaction: <T>(work: (tx: unknown) => Promise<T>): Promise<T> => work({}),
}))
vi.mock('#app/services/notifications/email-service.js', () => ({ emailService: emailServiceMock }))
vi.mock('#app/services/auth/auth-throttle-service.js', () => ({
    consumeAuthThrottle: consumeAuthThrottleMock,
}))
vi.mock('#logger', () => ({ default: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }))

const originalEnv = { ...process.env }

afterEach(() => {
    vi.resetModules()
    vi.resetAllMocks()
    consumeAuthThrottleMock.mockReset()
    for (const key of Object.keys(process.env)) {
        if (!(key in originalEnv)) delete process.env[key]
    }
    Object.assign(process.env, originalEnv)
})

type Service = typeof emailVerificationService

const IP = { ipAddress: '203.0.113.9' }

interface Row {
    method: string
    call: (service: Service) => Promise<unknown>
    consumed: readonly (readonly [string, string])[]
    blocked: { status: number; code: string; message: string }
    unavailable: string
}

const ROWS: readonly Row[] = [
    {
        method: 'verifyEmail · ip',
        call: (s) => s.verifyEmail('token', IP),
        consumed: [['verify_email_ip', '203.0.113.9']],
        blocked: {
            status: 400,
            code: 'bad_request',
            message: 'Too many verification attempts. Please try again later.',
        },
        unavailable: 'Failed to enforce email verification throttle',
    },
    {
        method: 'queueVerificationEmail · user',
        call: (s) => s.queueVerificationEmail(7n),
        consumed: [['resend_verification_user', '7']],
        blocked: {
            status: 400,
            code: 'bad_request',
            message: 'Too many verification emails requested. Please try again later.',
        },
        unavailable: 'Failed to enforce verification email throttle',
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

async function load(): Promise<Service> {
    process.env['FRONTEND_URL'] = 'https://app.example.com'
    process.env['APP_URL'] = 'https://app.example.com'
    return (await import('./email-verification-service.js')).emailVerificationService
}

function untouchedDownstream(): void {
    expect(userRepositoryMock.findById).not.toHaveBeenCalled()
    expect(userRepositoryMock.update).not.toHaveBeenCalled()
    expect(emailVerificationRepositoryMock.findByTokenHash).not.toHaveBeenCalled()
    expect(emailVerificationRepositoryMock.create).not.toHaveBeenCalled()
    expect(emailServiceMock.send).not.toHaveBeenCalled()
}

describe.each(ROWS)('emailVerificationService throttle: $method', (row) => {
    const target = row.consumed.at(-1)![0]

    it('consumes the counters in this order, with these keys', async () => {
        arrange(target, 'blocked')
        await row.call(await load())
        expect(
            consumeAuthThrottleMock.mock.calls.map(([policy, key]) => [
                (policy as { scope: string }).scope,
                key,
            ]),
        ).toEqual(row.consumed)
    })

    it('answers a spent counter with the stated error and does nothing further', async () => {
        arrange(target, 'blocked')
        const result = (await row.call(await load())) as Result<unknown, AppError>
        expect(Result.isError(result)).toBe(true)
        if (Result.isError(result)) expect(describeError(result.error)).toEqual(row.blocked)
        untouchedDownstream()
    })

    it('fails closed with a 500 and its own message when Redis does not answer', async () => {
        arrange(target, 'unavailable')
        const result = (await row.call(await load())) as Result<unknown, AppError>
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
        const result = (await row.call(await load())) as Result<unknown, AppError>
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
