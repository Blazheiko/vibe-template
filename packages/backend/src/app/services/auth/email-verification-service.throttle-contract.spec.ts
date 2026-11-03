import { Result } from 'better-result'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { classifyError } from '#vendor/utils/network/errors/classify-error.js'
import {
    appErrorCode,
    appErrorMessage,
    appErrorStatus,
    type AppError,
} from '#app/services/shared/errors.js'
import type { emailVerificationService } from './email-verification-service.js'

// feat-069 (G1): the throttle steps of emailVerificationService as a table, before they are
// folded into `enforceThrottle()` (H1). Same reading as auth-service.throttle-contract.spec.ts.

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
    expect(userRepositoryMock.lockById).not.toHaveBeenCalled()
    expect(userRepositoryMock.update).not.toHaveBeenCalled()
    expect(emailVerificationRepositoryMock.findByTokenHash).not.toHaveBeenCalled()
    expect(emailVerificationRepositoryMock.create).not.toHaveBeenCalled()
    expect(emailVerificationRepositoryMock.markUsed).not.toHaveBeenCalled()
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

    // ADR 0004: a Redis failure is not an AppError; the call rejects (fail closed) and the
    // transport answers. Nothing downstream may run on its behalf.
    it('fails closed when Redis does not answer: the call rejects, nothing downstream runs', async () => {
        arrange(target, 'unavailable')
        await expect(row.call(await load())).rejects.toThrow()
        untouchedDownstream()
    })

    it('a Redis outage becomes 503 at the transport, not 500', async () => {
        arrange(target, 'timeout')
        const thrown = await row.call(await load()).then(
            () => undefined,
            (err: unknown) => err,
        )
        expect(classifyError(thrown)).toMatchObject({ status: 503, code: 'service_unavailable' })
    })
})
