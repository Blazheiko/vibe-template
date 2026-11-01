import { Result } from 'better-result'
import { createHmac } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    appErrorCode,
    appErrorMessage,
    appErrorReason,
    appErrorStatus,
    type AppError,
} from '#app/services/shared/errors.js'
import type { passwordResetService } from './password-reset-service.js'

// feat-069 (G1): passwordResetService, state -> answer, before it is split (H2-H5). Every row
// names a state of the repositories and what the caller is told (status, code, message,
// reason) or gets back, and the side effects that must or must not have happened. The
// throttle steps are in password-reset-service.throttle-contract.spec.ts; the mail itself is
// frozen in auth-email-templates.snapshot.spec.ts.

const userRepositoryMock = {
    findByEmail: vi.fn(),
    findById: vi.fn(),
    findByPhone: vi.fn(),
    update: vi.fn(),
}
const resetRepositoryMock = {
    create: vi.fn(),
    findByTokenHash: vi.fn(),
    invalidatePendingByUserId: vi.fn(),
    markUsed: vi.fn(),
}
const challengeRepositoryMock = {
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
const issueMock = vi.fn()
const destroyAllSessionsMock = vi.fn()
const hashPasswordMock = vi.fn()
const consumeAuthThrottleMock = vi.fn()
const securityNotice = vi.fn()
const loggerMock = { warn: vi.fn(), error: vi.fn(), info: vi.fn() }
const TX = vi.hoisted(() => ({ transaction: true }))
const withTransactionMock = vi.fn(<T>(work: (tx: unknown) => Promise<T>): Promise<T> => work(TX))

vi.mock('#app/repositories/index.js', () => ({
    userRepository: userRepositoryMock,
    passwordResetRepository: resetRepositoryMock,
    smsAuthChallengeRepository: challengeRepositoryMock,
    withTransaction: (work: (tx: unknown) => Promise<unknown>) => withTransactionMock(work),
}))
vi.mock('#app/services/notifications/email-service.js', () => ({ emailService: emailServiceMock }))
vi.mock('#app/services/notifications/user-notification-service.js', () => ({
    userNotificationService: { security: securityNotice, supportReply: vi.fn() },
}))
vi.mock('#vendor/utils/session/redis-session-storage.js', () => ({
    destroyAllSessions: destroyAllSessionsMock,
}))
vi.mock('#app/services/auth/auth-throttle-service.js', () => ({
    consumeAuthThrottle: consumeAuthThrottleMock,
    resetAuthThrottle: vi.fn(),
}))
vi.mock('#app/services/auth/sms-verification-provider.js', () => ({
    smsVerificationProvider: { issueVerificationCode: issueMock },
}))
vi.mock('metautil', () => ({ hashPassword: hashPasswordMock }))
vi.mock('nanoid', () => ({ nanoid: () => 'rotated-token' }))
vi.mock('#logger', () => ({ default: loggerMock }))

const originalEnv = { ...process.env }
const SECRET = 'a'.repeat(32)
const otp = (code: string): string => createHmac('sha256', SECRET).update(code).digest('hex')
const FUTURE = new Date(Date.now() + 600_000)
const PAST = new Date(Date.now() - 1000)
const IP = { ipAddress: '203.0.113.9' }
const PHONE = '+380501234567'

beforeEach(() => {
    process.env['AUTH_PHONE_ENABLED'] = 'true'
    process.env['APP_KEY'] = SECRET
    process.env['AUTH_SMS_MAX_INVALID_ATTEMPTS'] = '3'
    process.env['FRONTEND_URL'] = 'https://app.example.com'
    process.env['APP_URL'] = 'https://app.example.com'
    consumeAuthThrottleMock.mockResolvedValue({ allowed: true, count: 1 })
    withTransactionMock.mockImplementation((work) => work(TX))
})

afterEach(() => {
    vi.resetModules()
    vi.resetAllMocks()
    for (const key of Object.keys(process.env)) {
        if (!(key in originalEnv)) delete process.env[key]
    }
    Object.assign(process.env, originalEnv)
})

type Service = typeof passwordResetService

interface Expected {
    status: number
    code: string
    message: string
    reason?: string
}
interface Row {
    name: string
    arrange?: () => void
    call: (service: Service) => Promise<unknown>
    error?: Expected
    ok?: unknown
    after?: () => void
}

const err = (status: number, code: string, message: string, reason?: string): Expected => ({
    status,
    code,
    message,
    ...(reason === undefined ? {} : { reason }),
})
const badRequest = (message: string, reason?: string): Expected =>
    err(400, 'bad_request', message, reason)
const internalError = (message: string): Expected => err(500, 'internal_error', message)

const GENERIC_EMAIL = 'If an account with that email exists, a reset link will be sent shortly.'
const GENERIC_PHONE =
    'If the phone number can be used for password reset, verification instructions will be sent shortly.'

const challenge = (over: Record<string, unknown> = {}) => ({
    id: 'ch-1',
    flow: 'reset_phone',
    phone: PHONE,
    codeHash: otp('123456'),
    attemptCount: 0,
    expiresAt: FUTURE,
    resendAvailableAt: new Date(Date.now() - 1000),
    invalidatedAt: null,
    confirmedAt: null,
    metadata: { userId: '7', sessionId: 'sess-1' },
    ...over,
})
const issued = () => ({
    id: 'ch-new',
    expiresAt: new Date('2030-01-01T00:10:00Z'),
    resendAvailableAt: new Date('2030-01-01T00:01:00Z'),
})
const user = (over: Record<string, unknown> = {}) => ({
    id: 7n,
    name: 'Jane',
    email: 'jane@example.com',
    phone: null,
    sessionToken: 'old-token',
    ...over,
})
const phoneOnlyUser = (over: Record<string, unknown> = {}) =>
    user({ email: null, phone: PHONE, ...over })
const token = (over: Record<string, unknown> = {}) => ({
    id: 11n,
    userId: 7n,
    usedAt: null,
    expiresAt: FUTURE,
    ...over,
})

const reset =
    (over: { token?: string; confirm?: string } = {}) =>
    (s: Service) =>
        s.resetPassword(over.token ?? 'tok', 'new-password', over.confirm ?? 'new-password', IP)
const completePhone =
    (code = '123456', confirm = 'new-password') =>
    (s: Service) =>
        s.completePhonePasswordReset('ch-1', code, 'new-password', confirm, IP)
const startPhone =
    (sessionId: string | null = 'sess-1') =>
    (s: Service) =>
        s.startPhonePasswordReset(PHONE, undefined, { ...IP, sessionId })

function arrangeResetOk(over: Record<string, unknown> = {}): void {
    resetRepositoryMock.findByTokenHash.mockResolvedValue(token())
    userRepositoryMock.findById.mockResolvedValue(user(over))
    hashPasswordMock.mockResolvedValue('new-hash')
    resetRepositoryMock.markUsed.mockResolvedValue(token())
    userRepositoryMock.update.mockResolvedValue(user())
    destroyAllSessionsMock.mockResolvedValue(undefined)
}
function arrangePhoneOk(): void {
    challengeRepositoryMock.findById.mockResolvedValue(challenge())
    userRepositoryMock.findById.mockResolvedValue(phoneOnlyUser())
    challengeRepositoryMock.markConfirmed.mockResolvedValue(challenge())
    hashPasswordMock.mockResolvedValue('new-hash')
    userRepositoryMock.update.mockResolvedValue(phoneOnlyUser())
    destroyAllSessionsMock.mockResolvedValue(undefined)
}
function arrangeStartOk(found: ReturnType<typeof phoneOnlyUser> | undefined): void {
    userRepositoryMock.findByPhone.mockResolvedValue(found)
    challengeRepositoryMock.create.mockResolvedValue(issued())
    issueMock.mockResolvedValue({ code: '123456', providerRequestId: 'p-1' })
    challengeRepositoryMock.markIssued.mockResolvedValue(issued())
}

const ROWS: readonly Row[] = [
    // --- requestPasswordReset ---------------------------------------------------------------
    {
        name: 'requestPasswordReset · known address: generic answer, mail goes out in the background',
        arrange: () => {
            userRepositoryMock.findByEmail.mockResolvedValue(user())
            userRepositoryMock.findById.mockResolvedValue(user())
            resetRepositoryMock.create.mockResolvedValue({ id: 1n })
            emailServiceMock.send.mockResolvedValue(Result.ok(undefined))
        },
        call: (s) => s.requestPasswordReset(' Jane@Example.com ', IP),
        ok: { message: GENERIC_EMAIL },
        after: () => {
            expect(userRepositoryMock.findByEmail).toHaveBeenCalledWith('jane@example.com')
        },
    },
    {
        name: 'requestPasswordReset · unknown address: the same answer, no mail',
        arrange: () => userRepositoryMock.findByEmail.mockResolvedValue(undefined),
        call: (s) => s.requestPasswordReset('nobody@example.com', IP),
        ok: { message: GENERIC_EMAIL },
        after: () => {
            expect(emailServiceMock.send).not.toHaveBeenCalled()
        },
    },
    {
        name: 'requestPasswordReset · the lookup fails: the same answer, logged with a masked address',
        arrange: () => userRepositoryMock.findByEmail.mockRejectedValue(new Error('db')),
        call: (s) => s.requestPasswordReset('jane@example.com', IP),
        ok: { message: GENERIC_EMAIL },
        after: () => {
            const [fields, text] = loggerMock.warn.mock.calls[0] as [
                Record<string, unknown>,
                string,
            ]
            expect(text).toBe('Failed to load user by email for password reset')
            expect(fields['emailMasked']).not.toContain('jane@')
            expect(emailServiceMock.send).not.toHaveBeenCalled()
        },
    },
    // --- sendPasswordResetEmail -------------------------------------------------------------
    {
        name: 'sendPasswordResetEmail · unknown user',
        arrange: () => userRepositoryMock.findById.mockResolvedValue(undefined),
        call: (s) => s.sendPasswordResetEmail(7n),
        error: err(404, 'not_found', 'User not found'),
    },
    {
        name: 'sendPasswordResetEmail · earlier tokens are invalidated before a new one is made',
        arrange: () => {
            userRepositoryMock.findById.mockResolvedValue(user())
            resetRepositoryMock.invalidatePendingByUserId.mockRejectedValue(new Error('db'))
        },
        call: (s) => s.sendPasswordResetEmail(7n),
        error: internalError('Failed to invalidate password reset tokens'),
        after: () => {
            expect(resetRepositoryMock.create).not.toHaveBeenCalled()
        },
    },
    {
        name: 'sendPasswordResetEmail · the token cannot be stored',
        arrange: () => {
            userRepositoryMock.findById.mockResolvedValue(user())
            resetRepositoryMock.create.mockRejectedValue(new Error('db'))
        },
        call: (s) => s.sendPasswordResetEmail(7n),
        error: internalError('Failed to create password reset token'),
        after: () => {
            expect(emailServiceMock.send).not.toHaveBeenCalled()
        },
    },
    {
        name: 'sendPasswordResetEmail · an account without an e-mail: token stored, nothing sent',
        arrange: () => {
            userRepositoryMock.findById.mockResolvedValue(user({ email: null }))
            resetRepositoryMock.create.mockResolvedValue({ id: 1n })
        },
        call: (s) => s.sendPasswordResetEmail(7n),
        ok: { message: GENERIC_EMAIL },
        after: () => {
            expect(emailServiceMock.send).not.toHaveBeenCalled()
        },
    },
    {
        name: 'sendPasswordResetEmail · the transport fails',
        arrange: () => {
            userRepositoryMock.findById.mockResolvedValue(user())
            resetRepositoryMock.create.mockResolvedValue({ id: 1n })
            emailServiceMock.send.mockResolvedValue(Result.err(new Error('smtp')))
        },
        call: (s) => s.sendPasswordResetEmail(7n),
        error: internalError('Failed to send password reset email'),
    },
    {
        name: 'sendPasswordResetEmail · sent: only the hash of the token is stored',
        arrange: () => {
            userRepositoryMock.findById.mockResolvedValue(user())
            resetRepositoryMock.create.mockResolvedValue({ id: 1n })
            emailServiceMock.send.mockResolvedValue(Result.ok(undefined))
        },
        call: (s) => s.sendPasswordResetEmail(7n),
        ok: { message: 'Password reset email sent' },
        after: () => {
            const created = resetRepositoryMock.create.mock.calls[0]![0] as {
                userId: bigint
                tokenHash: string
                expiresAt: Date
            }
            const mail = emailServiceMock.send.mock.calls[0]![0] as { to: string; text: string }
            const raw = /token=([\w-]+)/.exec(mail.text)![1]!
            expect(mail.to).toBe('jane@example.com')
            expect(created.userId).toBe(7n)
            expect(created.tokenHash).toMatch(/^[0-9a-f]{64}$/)
            expect(created.tokenHash).not.toContain(raw)
            expect(created.expiresAt.getTime() - Date.now()).toBeGreaterThan(59 * 60_000)
            expect(created.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(60 * 60_000)
        },
    },
    // --- resetPassword (by e-mail link) -----------------------------------------------------
    {
        name: 'resetPassword · blank token',
        call: reset({ token: '   ' }),
        error: badRequest('Password reset token is required', 'token_required'),
    },
    {
        name: 'resetPassword · the passwords differ',
        call: reset({ confirm: 'other' }),
        error: badRequest('Passwords do not match', 'passwords_mismatch'),
        after: () => {
            expect(resetRepositoryMock.findByTokenHash).not.toHaveBeenCalled()
        },
    },
    {
        name: 'resetPassword · unknown token',
        arrange: () => resetRepositoryMock.findByTokenHash.mockResolvedValue(undefined),
        call: reset(),
        error: badRequest('Password reset link is invalid', 'invalid_token'),
    },
    {
        name: 'resetPassword · the token has been used',
        arrange: () =>
            resetRepositoryMock.findByTokenHash.mockResolvedValue(token({ usedAt: new Date() })),
        call: reset(),
        error: badRequest('Password reset link has already been used', 'used_token'),
    },
    {
        name: 'resetPassword · the token has expired and is burnt',
        arrange: () =>
            resetRepositoryMock.findByTokenHash.mockResolvedValue(token({ expiresAt: PAST })),
        call: reset(),
        error: badRequest('Password reset link has expired', 'expired_token'),
        after: () => {
            expect(resetRepositoryMock.markUsed).toHaveBeenCalledWith(11n)
            expect(userRepositoryMock.update).not.toHaveBeenCalled()
        },
    },
    {
        name: 'resetPassword · the user is gone',
        arrange: () => {
            resetRepositoryMock.findByTokenHash.mockResolvedValue(token())
            userRepositoryMock.findById.mockResolvedValue(undefined)
        },
        call: reset(),
        error: err(404, 'not_found', 'User not found'),
    },
    {
        name: 'resetPassword · hashing fails, the token stays usable',
        arrange: () => {
            resetRepositoryMock.findByTokenHash.mockResolvedValue(token())
            userRepositoryMock.findById.mockResolvedValue(user())
            hashPasswordMock.mockRejectedValue(new Error('scrypt'))
        },
        call: reset(),
        error: internalError('Failed to hash password'),
        after: () => {
            expect(resetRepositoryMock.markUsed).not.toHaveBeenCalled()
        },
    },
    {
        name: 'resetPassword · the claim is lost to a concurrent request',
        arrange: () => {
            arrangeResetOk()
            resetRepositoryMock.markUsed.mockResolvedValue(undefined)
        },
        call: reset(),
        error: badRequest('Password reset link has already been used', 'used_token'),
        after: () => {
            expect(userRepositoryMock.update).not.toHaveBeenCalled()
            expect(destroyAllSessionsMock).not.toHaveBeenCalled()
            expect(securityNotice).not.toHaveBeenCalled()
        },
    },
    {
        name: 'resetPassword · a failure inside the transaction fails the request',
        arrange: () => {
            arrangeResetOk()
            userRepositoryMock.update.mockResolvedValue(undefined)
        },
        call: reset(),
        error: internalError('Failed to update password'),
        after: () => {
            expect(destroyAllSessionsMock).not.toHaveBeenCalled()
            expect(securityNotice).not.toHaveBeenCalled()
        },
    },
    {
        name: 'resetPassword · a phone challenge cannot be invalidated',
        arrange: () => {
            arrangeResetOk({ phone: PHONE })
            challengeRepositoryMock.invalidatePendingForPhoneFlow.mockRejectedValue(new Error('db'))
        },
        call: reset(),
        error: internalError(
            'Failed to invalidate pending phone challenges after email password reset',
        ),
        after: () => {
            expect(withTransactionMock).not.toHaveBeenCalled()
        },
    },
    {
        name: 'resetPassword · cleanup of old sessions fails, the reset stands',
        arrange: () => {
            arrangeResetOk()
            destroyAllSessionsMock.mockRejectedValue(new Error('redis'))
        },
        call: reset(),
        ok: { status: 'success' },
        after: () => {
            expect(loggerMock.warn).toHaveBeenCalledWith(
                expect.objectContaining({ userId: '7' }),
                'Previous sessions not deleted after a password reset',
            )
            expect(securityNotice).toHaveBeenCalledWith(7n, 'password_reset')
        },
    },
    {
        name: 'resetPassword · ok claims the token and rotates the session token in one transaction',
        arrange: () => {
            arrangeResetOk({ phone: PHONE })
        },
        call: reset({ token: ' tok ' }),
        ok: { status: 'success' },
        after: () => {
            expect(withTransactionMock).toHaveBeenCalledTimes(1)
            expect(resetRepositoryMock.markUsed).toHaveBeenCalledWith(11n, undefined, TX)
            expect(userRepositoryMock.update).toHaveBeenCalledWith(
                7n,
                { password: 'new-hash', sessionToken: 'rotated-token' },
                TX,
            )
            expect(challengeRepositoryMock.invalidatePendingForPhoneFlow).toHaveBeenCalledWith(
                PHONE,
                'reset_phone',
            )
            expect(challengeRepositoryMock.invalidatePendingForPhoneFlow).toHaveBeenCalledWith(
                PHONE,
                'link_phone',
            )
            expect(destroyAllSessionsMock).toHaveBeenCalledWith('old-token')
            expect(securityNotice).toHaveBeenCalledWith(7n, 'password_reset')
        },
    },
    // --- startPhonePasswordReset ------------------------------------------------------------
    {
        name: 'startPhonePasswordReset · phone login disabled',
        arrange: () => {
            process.env['AUTH_PHONE_ENABLED'] = 'false'
        },
        call: startPhone(),
        error: badRequest('Phone authentication is disabled'),
    },
    {
        name: 'startPhonePasswordReset · invalid phone',
        call: (s) => s.startPhonePasswordReset('nope', undefined, { ...IP, sessionId: 's' }),
        error: badRequest('Phone number must be valid and in a supported format'),
    },
    {
        name: 'startPhonePasswordReset · the lookup fails: generic answer, logged',
        arrange: () => userRepositoryMock.findByPhone.mockRejectedValue(new Error('db')),
        call: startPhone(),
        ok: { message: GENERIC_PHONE },
        after: () => {
            expect(loggerMock.warn).toHaveBeenCalledWith(
                expect.objectContaining({ phoneMasked: expect.not.stringContaining('0501234') }),
                'Failed to load user by phone for password reset',
            )
        },
    },
    {
        name: 'startPhonePasswordReset · a code was sent a moment ago',
        arrange: () => {
            userRepositoryMock.findByPhone.mockResolvedValue(phoneOnlyUser())
            challengeRepositoryMock.findLatestPendingForPhoneFlow.mockResolvedValue(
                challenge({ resendAvailableAt: new Date(Date.now() + 30_000) }),
            )
        },
        call: startPhone(),
        error: err(
            429,
            'rate_limited',
            'A verification code was already sent recently. Please wait before requesting another one.',
            'resend_cooldown_active',
        ),
    },
    {
        name: 'startPhonePasswordReset · a live challenge of this session is handed back',
        arrange: () => {
            userRepositoryMock.findByPhone.mockResolvedValue(phoneOnlyUser())
            challengeRepositoryMock.findLatestPendingForPhoneFlow.mockResolvedValue(challenge())
        },
        call: startPhone('sess-1'),
        ok: {
            message: GENERIC_PHONE,
            challengeId: 'ch-1',
            expiresAt: FUTURE.toISOString(),
            resendAvailableAt: expect.any(String),
        },
        after: () => {
            expect(challengeRepositoryMock.create).not.toHaveBeenCalled()
        },
    },
    {
        name: 'startPhonePasswordReset · a live challenge of another session is not revealed',
        arrange: () => {
            userRepositoryMock.findByPhone.mockResolvedValue(phoneOnlyUser())
            challengeRepositoryMock.findLatestPendingForPhoneFlow.mockResolvedValue(challenge())
        },
        call: startPhone('other'),
        ok: { message: GENERIC_PHONE },
        after: () => {
            expect(challengeRepositoryMock.create).not.toHaveBeenCalled()
        },
    },
    {
        name: 'startPhonePasswordReset · the provider fails, the challenge is invalidated',
        arrange: () => {
            arrangeStartOk(phoneOnlyUser())
            issueMock.mockRejectedValue(new Error('sms down'))
        },
        call: startPhone(),
        error: internalError('Failed to issue SMS verification code'),
        after: () => {
            expect(challengeRepositoryMock.markInvalidated).toHaveBeenCalledWith('ch-new')
        },
    },
    {
        name: 'startPhonePasswordReset · the issued code cannot be stored',
        arrange: () => {
            arrangeStartOk(phoneOnlyUser())
            challengeRepositoryMock.markIssued.mockRejectedValue(new Error('db'))
        },
        call: startPhone(),
        error: internalError('Failed to persist issued phone reset challenge'),
        after: () => {
            expect(challengeRepositoryMock.markInvalidated).toHaveBeenCalledWith('ch-new')
        },
    },
    {
        name: 'startPhonePasswordReset · the challenge was invalidated meanwhile',
        arrange: () => {
            arrangeStartOk(phoneOnlyUser())
            challengeRepositoryMock.markIssued.mockResolvedValue(undefined)
        },
        call: startPhone(),
        error: badRequest('Phone reset challenge is no longer valid'),
        after: () => {
            expect(challengeRepositoryMock.markInvalidated).toHaveBeenCalledWith('ch-new')
        },
    },
    {
        name: 'startPhonePasswordReset · a phone-only account gets an SMS',
        arrange: () => {
            arrangeStartOk(phoneOnlyUser())
        },
        call: startPhone(),
        ok: {
            message: GENERIC_PHONE,
            challengeId: 'ch-new',
            expiresAt: '2030-01-01T00:10:00.000Z',
            resendAvailableAt: '2030-01-01T00:01:00.000Z',
        },
        after: () => {
            expect(issueMock).toHaveBeenCalledWith({ phone: PHONE, flow: 'reset_phone' })
            expect(challengeRepositoryMock.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    flow: 'reset_phone',
                    metadata: expect.objectContaining({ userId: '7', sessionId: 'sess-1' }),
                }),
            )
        },
    },
    {
        name: 'startPhonePasswordReset · an account with an e-mail looks the same but sends nothing',
        arrange: () => {
            arrangeStartOk(user({ phone: PHONE }))
        },
        call: startPhone(),
        ok: {
            message: GENERIC_PHONE,
            challengeId: 'ch-new',
            expiresAt: '2030-01-01T00:10:00.000Z',
            resendAvailableAt: '2030-01-01T00:01:00.000Z',
        },
        after: () => {
            expect(issueMock).not.toHaveBeenCalled()
            expect(challengeRepositoryMock.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    metadata: expect.objectContaining({ blind: true }),
                }),
            )
        },
    },
    {
        name: 'startPhonePasswordReset · an unknown phone looks the same but sends nothing',
        arrange: () => {
            arrangeStartOk(undefined)
        },
        call: startPhone(),
        ok: {
            message: GENERIC_PHONE,
            challengeId: 'ch-new',
            expiresAt: '2030-01-01T00:10:00.000Z',
            resendAvailableAt: '2030-01-01T00:01:00.000Z',
        },
        after: () => {
            expect(issueMock).not.toHaveBeenCalled()
        },
    },
    // --- completePhonePasswordReset ---------------------------------------------------------
    {
        name: 'completePhonePasswordReset · phone login disabled',
        arrange: () => {
            process.env['AUTH_PHONE_ENABLED'] = 'false'
        },
        call: completePhone(),
        error: badRequest('Phone authentication is disabled'),
    },
    {
        name: 'completePhonePasswordReset · the passwords differ, before any counter is spent',
        call: completePhone('123456', 'other'),
        error: badRequest('Passwords do not match', 'passwords_mismatch'),
        after: () => {
            expect(consumeAuthThrottleMock).not.toHaveBeenCalled()
        },
    },
    {
        name: 'completePhonePasswordReset · unknown challenge',
        arrange: () => challengeRepositoryMock.findById.mockResolvedValue(undefined),
        call: completePhone(),
        error: badRequest('Phone reset challenge is invalid'),
    },
    {
        name: 'completePhonePasswordReset · challenge of another flow',
        arrange: () =>
            challengeRepositoryMock.findById.mockResolvedValue(challenge({ flow: 'link_phone' })),
        call: completePhone(),
        error: badRequest('Phone reset challenge is invalid'),
    },
    {
        name: 'completePhonePasswordReset · expired',
        arrange: () =>
            challengeRepositoryMock.findById.mockResolvedValue(challenge({ expiresAt: PAST })),
        call: completePhone(),
        error: badRequest('Phone reset challenge is no longer valid'),
    },
    {
        name: 'completePhonePasswordReset · wrong code counts an attempt',
        arrange: () => {
            challengeRepositoryMock.findById.mockResolvedValue(challenge())
            challengeRepositoryMock.incrementAttemptCount.mockResolvedValue({ attemptCount: 1 })
        },
        call: completePhone('000000'),
        error: badRequest('Invalid verification code'),
        after: () => {
            expect(challengeRepositoryMock.incrementAttemptCount).toHaveBeenCalledWith('ch-1')
            expect(challengeRepositoryMock.markInvalidated).not.toHaveBeenCalled()
        },
    },
    {
        name: 'completePhonePasswordReset · the last wrong attempt invalidates the challenge',
        arrange: () => {
            challengeRepositoryMock.findById.mockResolvedValue(challenge({ attemptCount: 2 }))
            challengeRepositoryMock.incrementAttemptCount.mockResolvedValue({ attemptCount: 3 })
        },
        call: completePhone('000000'),
        error: badRequest('Invalid verification code'),
        after: () => {
            expect(challengeRepositoryMock.markInvalidated).toHaveBeenCalledWith('ch-1')
        },
    },
    {
        name: 'completePhonePasswordReset · a blind challenge (no user) fails like a wrong code',
        arrange: () =>
            challengeRepositoryMock.findById.mockResolvedValue(
                challenge({ metadata: { blind: true } }),
            ),
        call: completePhone(),
        error: badRequest('Invalid verification code'),
        after: () => {
            expect(userRepositoryMock.findById).not.toHaveBeenCalled()
        },
    },
    {
        name: 'completePhonePasswordReset · the account has an e-mail now',
        arrange: () => {
            challengeRepositoryMock.findById.mockResolvedValue(challenge())
            userRepositoryMock.findById.mockResolvedValue(user({ phone: PHONE }))
        },
        call: completePhone(),
        error: badRequest('Phone reset challenge is invalid'),
    },
    {
        name: 'completePhonePasswordReset · the account has another phone now',
        arrange: () => {
            challengeRepositoryMock.findById.mockResolvedValue(challenge())
            userRepositoryMock.findById.mockResolvedValue(phoneOnlyUser({ phone: '+380509999999' }))
        },
        call: completePhone(),
        error: badRequest('Phone reset challenge is invalid'),
    },
    {
        name: 'completePhonePasswordReset · the user is gone',
        arrange: () => {
            challengeRepositoryMock.findById.mockResolvedValue(challenge())
            userRepositoryMock.findById.mockResolvedValue(undefined)
        },
        call: completePhone(),
        error: badRequest('Phone reset challenge is invalid'),
    },
    {
        name: 'completePhonePasswordReset · lost the race to confirm',
        arrange: () => {
            arrangePhoneOk()
            challengeRepositoryMock.markConfirmed.mockResolvedValue(undefined)
        },
        call: completePhone(),
        error: badRequest('Phone reset challenge is no longer valid'),
        after: () => {
            expect(userRepositoryMock.update).not.toHaveBeenCalled()
        },
    },
    {
        name: 'completePhonePasswordReset · the update returns nothing',
        arrange: () => {
            arrangePhoneOk()
            userRepositoryMock.update.mockResolvedValue(undefined)
        },
        call: completePhone(),
        error: internalError('Failed to update password'),
        after: () => {
            expect(securityNotice).not.toHaveBeenCalled()
        },
    },
    {
        name: 'completePhonePasswordReset · cleanup of old sessions fails, the reset stands',
        arrange: () => {
            arrangePhoneOk()
            destroyAllSessionsMock.mockRejectedValue(new Error('redis'))
        },
        call: completePhone(),
        ok: { status: 'success' },
        after: () => {
            expect(loggerMock.warn).toHaveBeenCalledWith(
                expect.objectContaining({ userId: '7' }),
                'Previous sessions not deleted after a password reset',
            )
            expect(securityNotice).toHaveBeenCalledWith(7n, 'password_reset')
        },
    },
    {
        name: 'completePhonePasswordReset · ok rotates the session token and drops the old sessions',
        arrange: arrangePhoneOk,
        call: completePhone(),
        ok: { status: 'success' },
        after: () => {
            expect(userRepositoryMock.update).toHaveBeenCalledWith(7n, {
                password: 'new-hash',
                sessionToken: 'rotated-token',
            })
            expect(destroyAllSessionsMock).toHaveBeenCalledWith('old-token')
            expect(challengeRepositoryMock.invalidatePendingForPhoneFlow).toHaveBeenCalledWith(
                PHONE,
                'reset_phone',
            )
            expect(securityNotice).toHaveBeenCalledWith(7n, 'password_reset')
        },
    },
]

function describeError(error: AppError): Expected {
    const reason = appErrorReason(error)
    return {
        status: appErrorStatus(error),
        code: appErrorCode(error),
        message: appErrorMessage(error),
        ...(reason === undefined ? {} : { reason }),
    }
}

describe.each(ROWS)('passwordResetService · $name', (row) => {
    it('answers as the table says and leaves the stated side effects', async () => {
        row.arrange?.()
        const { passwordResetService } = await import('./password-reset-service.js')
        const result = (await row.call(passwordResetService)) as Result<unknown, AppError>

        if (row.error === undefined) {
            expect(
                Result.isOk(result),
                JSON.stringify(Result.isError(result) && result.error),
            ).toBe(true)
            if (Result.isOk(result) && row.ok !== undefined) expect(result.value).toEqual(row.ok)
        } else {
            expect(Result.isError(result)).toBe(true)
            if (Result.isError(result)) expect(describeError(result.error)).toEqual(row.error)
        }
        // requestPasswordReset sends its mail from a detached promise: let it settle.
        await new Promise((resolve) => setImmediate(resolve))
        row.after?.()
    })
})

describe('passwordResetService · sendPasswordResetEmailInBackground', () => {
    it('logs a failed send as a warning with the reason and the trigger, and does not throw', async () => {
        userRepositoryMock.findById.mockResolvedValue(undefined)
        const { passwordResetService } = await import('./password-reset-service.js')
        await expect(
            passwordResetService.sendPasswordResetEmailInBackground(7n, 'manual request'),
        ).resolves.toBeUndefined()
        expect(loggerMock.warn).toHaveBeenCalledWith(
            { userId: '7', reason: 'User not found', trigger: 'manual request' },
            'Failed to send password reset email in background',
        )
    })

    it('logs an unexpected throw as an error and does not throw', async () => {
        const boom = new Error('boom')
        const { passwordResetService } = await import('./password-reset-service.js')
        vi.spyOn(passwordResetService, 'sendPasswordResetEmail').mockRejectedValue(boom)
        await expect(
            passwordResetService.sendPasswordResetEmailInBackground(7n, 'manual request'),
        ).resolves.toBeUndefined()
        expect(loggerMock.error).toHaveBeenCalledWith(
            { err: boom, userId: '7', trigger: 'manual request' },
            'Unexpected error while sending password reset email in background',
        )
    })

    it('stays quiet when the mail goes out', async () => {
        userRepositoryMock.findById.mockResolvedValue(user())
        resetRepositoryMock.create.mockResolvedValue({ id: 1n })
        emailServiceMock.send.mockResolvedValue(Result.ok(undefined))
        const { passwordResetService } = await import('./password-reset-service.js')
        await passwordResetService.sendPasswordResetEmailInBackground(7n, 'manual request')
        expect(loggerMock.warn).not.toHaveBeenCalled()
        expect(loggerMock.error).not.toHaveBeenCalled()
    })
})
