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
    lockById: vi.fn(),
}
const resetRepositoryMock = {
    create: vi.fn(),
    findByTokenHash: vi.fn(),
    invalidatePendingByUserId: vi.fn(),
    markUsed: vi.fn(),
    burn: vi.fn(),
}
const challengeRepositoryMock = {
    create: vi.fn(),
    findById: vi.fn(),
    findLatestPendingForPhoneFlow: vi.fn(),
    // feat-204: the waiting challenges of a number, newest first; a start retires its own.
    findPendingForPhoneFlow: vi.fn(),
    invalidatePendingByIds: vi.fn(),
    lockPhoneFlow: vi.fn(() => Promise.resolve()),
    invalidatePendingForPhoneFlow: vi.fn(),
    consumeAttempt: vi.fn(),
    markInvalidatedIfPending: vi.fn(),
    markConfirmed: vi.fn(),
    markInvalidated: vi.fn(),
    markIssued: vi.fn(),
}
const emailServiceMock = { send: vi.fn() }
const issueMock = vi.fn()
const destroyAllSessionsMock = vi.fn(() => Promise.resolve({ deleted: 0, complete: true }))
const hashPasswordMock = vi.fn()
const consumeAuthThrottleMock = vi.fn()
const resetAuthThrottleMock = vi.fn()
const securityNotice = vi.fn()
const loggerMock = { warn: vi.fn(), error: vi.fn(), info: vi.fn() }
const TX = vi.hoisted(() => ({ transaction: true }))
const withTransactionMock = vi.fn(<T>(work: (tx: unknown) => Promise<T>): Promise<T> => work(TX))

// feat-097: the repositories a claim of an unverified account touches (account-claim-service).
const claimRepositoryMocks = vi.hoisted(() => ({
    emailVerificationRepository: { invalidatePendingByUserId: vi.fn() },
    emailLinkVerificationRepository: { invalidatePendingByUserId: vi.fn() },
    oauthLinkVerificationRepository: { invalidatePendingByUserId: vi.fn() },
    oauthAccountRepository: { deleteByUserId: vi.fn() },
    pushSubscriptionRepository: { deleteByUserId: vi.fn() },
}))
vi.mock('#app/repositories/index.js', () => ({
    userRepository: userRepositoryMock,
    passwordResetRepository: resetRepositoryMock,
    smsAuthChallengeRepository: challengeRepositoryMock,
    ...claimRepositoryMocks,
    withTransaction: (work: (tx: unknown) => Promise<unknown>) => withTransactionMock(work),
}))
vi.mock('#app/services/notifications/email-service.js', () => ({ emailService: emailServiceMock }))
vi.mock('#app/services/notifications/user-notification-service.js', () => ({
    userNotificationService: { security: securityNotice, supportReply: vi.fn() },
}))
// feat-199: what the reset says about the sign-in methods still linked (own spec).
vi.mock('#app/services/auth/password-reset-notice.js', () => ({
    announcePasswordReset: () => Promise.resolve(['github']),
}))
vi.mock('#vendor/utils/session/redis-session-storage.js', () => ({
    destroyAllSessions: destroyAllSessionsMock,
}))
vi.mock('#app/services/auth/auth-throttle-service.js', () => ({
    consumeAuthThrottle: consumeAuthThrottleMock,
    resetAuthThrottle: resetAuthThrottleMock,
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
    // feat-103: every code check spends a try first; by default the try succeeds on the row
    // findById returns.
    challengeRepositoryMock.consumeAttempt.mockImplementation(async (id: string) => {
        const found = (await challengeRepositoryMock.findById(id)) as
            { attemptCount?: number } | undefined
        return found === undefined
            ? undefined
            : { ...found, attemptCount: (found.attemptCount ?? 0) + 1 }
    })
    process.env['AUTH_PHONE_ENABLED'] = 'true'
    process.env['APP_KEY'] = SECRET
    process.env['AUTH_SMS_MAX_INVALID_ATTEMPTS'] = '3'
    process.env['FRONTEND_URL'] = 'https://app.example.com'
    process.env['APP_URL'] = 'https://app.example.com'
    consumeAuthThrottleMock.mockResolvedValue({ allowed: true, count: 1 })
    // No waiting challenge unless a row says otherwise.
    challengeRepositoryMock.findPendingForPhoneFlow.mockResolvedValue([])
    challengeRepositoryMock.invalidatePendingByIds.mockResolvedValue(0)
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
    /** The call rejects: an infrastructure failure propagates (ADR 0004). */
    throws?: true
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
    // feat-097: verified unless a row says otherwise (an unverified one is claimed).
    emailVerifiedAt: new Date('2026-01-01T00:00:00Z'),
    phone: null,
    sessionToken: 'old-token',
    ...over,
})
const phoneOnlyUser = (over: Record<string, unknown> = {}) =>
    user({ email: null, phone: PHONE, ...over })
const token = (over: Record<string, unknown> = {}) => ({
    id: 11n,
    userId: 7n,
    // feat-097: the address the link was mailed to.
    targetEmail: 'jane@example.com',
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
    userRepositoryMock.lockById.mockResolvedValue(user(over))
    hashPasswordMock.mockResolvedValue('new-hash')
    resetRepositoryMock.markUsed.mockResolvedValue(token())
    userRepositoryMock.update.mockResolvedValue(user())
    destroyAllSessionsMock.mockResolvedValue({ deleted: 0, complete: true })
}
function arrangePhoneOk(): void {
    challengeRepositoryMock.findById.mockResolvedValue(challenge())
    // feat-106: the account is read on the row locked inside the reset transaction.
    userRepositoryMock.lockById.mockResolvedValue(phoneOnlyUser())
    challengeRepositoryMock.markConfirmed.mockResolvedValue(challenge())
    hashPasswordMock.mockResolvedValue('new-hash')
    userRepositoryMock.update.mockResolvedValue(phoneOnlyUser())
    destroyAllSessionsMock.mockResolvedValue({ deleted: 0, complete: true })
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
            userRepositoryMock.lockById.mockResolvedValue(user())
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
        arrange: () => userRepositoryMock.lockById.mockResolvedValue(undefined),
        call: (s) => s.sendPasswordResetEmail(7n),
        error: err(404, 'not_found', 'User not found'),
    },
    {
        name: 'sendPasswordResetEmail · earlier tokens are invalidated before a new one is made',
        arrange: () => {
            userRepositoryMock.lockById.mockResolvedValue(user())
            resetRepositoryMock.invalidatePendingByUserId.mockRejectedValue(new Error('db'))
        },
        call: (s) => s.sendPasswordResetEmail(7n),
        throws: true,
        after: () => {
            expect(resetRepositoryMock.create).not.toHaveBeenCalled()
        },
    },
    {
        name: 'sendPasswordResetEmail · the token cannot be stored',
        arrange: () => {
            userRepositoryMock.lockById.mockResolvedValue(user())
            resetRepositoryMock.create.mockRejectedValue(new Error('db'))
        },
        call: (s) => s.sendPasswordResetEmail(7n),
        throws: true,
        after: () => {
            expect(emailServiceMock.send).not.toHaveBeenCalled()
        },
    },
    {
        // feat-096: refused on the locked row, so no token is made for an account without
        // an address (and its earlier ones are left alone); the answer is still generic.
        name: 'sendPasswordResetEmail · an account without an e-mail: no token, nothing sent',
        arrange: () => {
            userRepositoryMock.lockById.mockResolvedValue(user({ email: null }))
            resetRepositoryMock.create.mockResolvedValue({ id: 1n })
        },
        call: (s) => s.sendPasswordResetEmail(7n),
        ok: { message: GENERIC_EMAIL },
        after: () => {
            expect(resetRepositoryMock.invalidatePendingByUserId).not.toHaveBeenCalled()
            expect(resetRepositoryMock.create).not.toHaveBeenCalled()
            expect(emailServiceMock.send).not.toHaveBeenCalled()
        },
    },
    {
        name: 'sendPasswordResetEmail · the transport fails',
        arrange: () => {
            userRepositoryMock.lockById.mockResolvedValue(user())
            resetRepositoryMock.create.mockResolvedValue({ id: 1n })
            emailServiceMock.send.mockRejectedValue(new Error('smtp'))
        },
        call: (s) => s.sendPasswordResetEmail(7n),
        throws: true,
    },
    {
        name: 'sendPasswordResetEmail · sent: only the hash of the token is stored',
        arrange: () => {
            userRepositoryMock.lockById.mockResolvedValue(user())
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
            // feat-097: the address of the locked row, which a reset later proves.
            expect(created).toMatchObject({ targetEmail: 'jane@example.com' })
            expect(created.tokenHash).toMatch(/^[0-9a-f]{64}$/)
            expect(created.tokenHash).not.toContain(raw)
            expect(created.expiresAt.getTime() - Date.now()).toBeGreaterThan(59 * 60_000)
            expect(created.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(60 * 60_000)
            // feat-096: lock, retire and store in one transaction, in that order.
            expect(withTransactionMock).toHaveBeenCalledTimes(1)
            expect(userRepositoryMock.lockById).toHaveBeenCalledWith(7n, TX)
            expect(resetRepositoryMock.invalidatePendingByUserId).toHaveBeenCalledWith(7n, TX)
            expect(resetRepositoryMock.create).toHaveBeenCalledWith(expect.anything(), TX)
            expect(userRepositoryMock.lockById.mock.invocationCallOrder[0]).toBeLessThan(
                resetRepositoryMock.invalidatePendingByUserId.mock.invocationCallOrder[0]!,
            )
            expect(
                resetRepositoryMock.invalidatePendingByUserId.mock.invocationCallOrder[0],
            ).toBeLessThan(resetRepositoryMock.create.mock.invocationCallOrder[0]!)
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
            expect(resetRepositoryMock.burn).toHaveBeenCalledWith(11n)
            expect(resetRepositoryMock.markUsed).not.toHaveBeenCalled()
            expect(userRepositoryMock.update).not.toHaveBeenCalled()
        },
    },
    {
        name: 'resetPassword · the user is gone',
        arrange: () => {
            resetRepositoryMock.findByTokenHash.mockResolvedValue(token())
            userRepositoryMock.lockById.mockResolvedValue(undefined)
            hashPasswordMock.mockResolvedValue('new-hash')
        },
        call: reset(),
        error: err(404, 'not_found', 'User not found'),
        after: () => {
            expect(resetRepositoryMock.markUsed).not.toHaveBeenCalled()
            expect(userRepositoryMock.update).not.toHaveBeenCalled()
            expect(destroyAllSessionsMock).not.toHaveBeenCalled()
        },
    },
    {
        name: 'resetPassword · hashing fails, the token stays usable',
        arrange: () => {
            resetRepositoryMock.findByTokenHash.mockResolvedValue(token())
            userRepositoryMock.lockById.mockResolvedValue(user())
            hashPasswordMock.mockRejectedValue(new Error('scrypt'))
        },
        call: reset(),
        throws: true,
        after: () => {
            // Hashed before the transaction: the user lock is not held over scrypt.
            expect(withTransactionMock).not.toHaveBeenCalled()
            expect(userRepositoryMock.lockById).not.toHaveBeenCalled()
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
            expect(resetRepositoryMock.invalidatePendingByUserId).not.toHaveBeenCalled()
            expect(challengeRepositoryMock.invalidatePendingForPhoneFlow).not.toHaveBeenCalled()
            expect(destroyAllSessionsMock).not.toHaveBeenCalled()
            expect(securityNotice).not.toHaveBeenCalled()
        },
    },
    {
        name: 'resetPassword · the token expired while waiting for the user lock',
        arrange: () => {
            arrangeResetOk()
            // Valid for 5 ms from the lookup on; the claim comes 20 ms later and refuses it.
            resetRepositoryMock.findByTokenHash.mockImplementation(() =>
                Promise.resolve(token({ expiresAt: new Date(Date.now() + 5) })),
            )
            resetRepositoryMock.markUsed.mockImplementation(
                () =>
                    new Promise((resolve) =>
                        setTimeout(() => {
                            resolve(undefined)
                        }, 20),
                    ),
            )
        },
        call: reset(),
        error: badRequest('Password reset link has expired', 'expired_token'),
        after: () => {
            expect(userRepositoryMock.update).not.toHaveBeenCalled()
            expect(destroyAllSessionsMock).not.toHaveBeenCalled()
        },
    },
    {
        name: 'resetPassword · a failure inside the transaction fails the request',
        arrange: () => {
            arrangeResetOk()
            userRepositoryMock.update.mockResolvedValue(undefined)
        },
        call: reset(),
        throws: true,
        after: () => {
            expect(destroyAllSessionsMock).not.toHaveBeenCalled()
            expect(securityNotice).not.toHaveBeenCalled()
        },
    },
    {
        // feat-096: the phone challenges are retired in the reset's transaction (the phone is
        // read from the locked row): their failure rolls the reset back, nothing half done.
        name: 'resetPassword · a phone challenge cannot be invalidated, the reset rolls back',
        arrange: () => {
            arrangeResetOk({ phone: PHONE })
            challengeRepositoryMock.invalidatePendingForPhoneFlow.mockRejectedValue(new Error('db'))
        },
        call: reset(),
        throws: true,
        after: () => {
            expect(withTransactionMock).toHaveBeenCalledTimes(1)
            expect(userRepositoryMock.update).toHaveBeenCalledWith(
                7n,
                { password: 'new-hash', sessionToken: 'rotated-token' },
                TX,
            )
            expect(userRepositoryMock.update.mock.invocationCallOrder[0]).toBeLessThan(
                challengeRepositoryMock.invalidatePendingForPhoneFlow.mock.invocationCallOrder[0]!,
            )
            expect(challengeRepositoryMock.invalidatePendingForPhoneFlow).toHaveBeenCalledWith(
                PHONE,
                'reset_phone',
                TX,
            )
            // The throw left the transaction, so nothing after the commit ran.
            expect(destroyAllSessionsMock).not.toHaveBeenCalled()
            expect(securityNotice).not.toHaveBeenCalled()
        },
    },
    {
        name: 'resetPassword · cleanup of old sessions fails, the reset stands',
        arrange: () => {
            arrangeResetOk()
            destroyAllSessionsMock.mockRejectedValue(new Error('redis'))
        },
        call: reset(),
        ok: { status: 'success', signInMethods: ['github'] },
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
        ok: { status: 'success', signInMethods: ['github'] },
        after: () => {
            expect(withTransactionMock).toHaveBeenCalledTimes(1)
            expect(userRepositoryMock.lockById).toHaveBeenCalledWith(7n, TX)
            expect(userRepositoryMock.findById).not.toHaveBeenCalled()
            expect(resetRepositoryMock.markUsed).toHaveBeenCalledWith(11n, TX)
            expect(userRepositoryMock.update).toHaveBeenCalledWith(
                7n,
                { password: 'new-hash', sessionToken: 'rotated-token' },
                TX,
            )
            expect(resetRepositoryMock.invalidatePendingByUserId).toHaveBeenCalledWith(7n, TX)
            expect(userRepositoryMock.lockById.mock.invocationCallOrder[0]).toBeLessThan(
                resetRepositoryMock.markUsed.mock.invocationCallOrder[0]!,
            )
            expect(resetRepositoryMock.markUsed.mock.invocationCallOrder[0]).toBeLessThan(
                userRepositoryMock.update.mock.invocationCallOrder[0]!,
            )
            expect(challengeRepositoryMock.invalidatePendingForPhoneFlow).toHaveBeenCalledWith(
                PHONE,
                'reset_phone',
                TX,
            )
            expect(challengeRepositoryMock.invalidatePendingForPhoneFlow).toHaveBeenCalledWith(
                PHONE,
                'link_phone',
                TX,
            )
            expect(destroyAllSessionsMock).toHaveBeenCalledWith('old-token')
            expect(securityNotice).toHaveBeenCalledWith(7n, 'password_reset')
        },
    },
    // feat-097: the link proves the address it was mailed to, and only while the account
    // still has it. A refusal uses the link up and changes nothing else.
    ...(
        [
            [
                'the account address changed after the link was sent',
                { targetEmail: 'old@example.com' },
            ],
            ['the link has no address (issued before feat-097)', { targetEmail: null }],
        ] as const
    ).map(([label, over]): Row => ({
        name: `resetPassword · ${label}: 409 email_changed, the link is used up`,
        arrange: () => {
            arrangeResetOk()
            resetRepositoryMock.findByTokenHash.mockResolvedValue(token(over))
        },
        call: reset(),
        error: err(
            409,
            'conflict',
            'The account email changed after this link was sent',
            'email_changed',
        ),
        after: () => {
            expect(resetRepositoryMock.markUsed).toHaveBeenCalledWith(11n, TX)
            expect(userRepositoryMock.update).not.toHaveBeenCalled()
            expect(destroyAllSessionsMock).not.toHaveBeenCalled()
            expect(securityNotice).not.toHaveBeenCalled()
        },
    })),
    {
        name: 'resetPassword · the address matches up to case and spaces',
        arrange: () => {
            arrangeResetOk({ email: 'Jane@Example.com' })
            resetRepositoryMock.findByTokenHash.mockResolvedValue(
                token({ targetEmail: ' jane@example.COM ' }),
            )
        },
        call: reset(),
        ok: { status: 'success', signInMethods: ['github'] },
    },
    {
        // feat-097: the first proof of the mailbox on an unverified account hands it to the
        // mailbox owner: everything set up before the address was proven goes.
        name: 'resetPassword · an unverified account is claimed by the reset',
        arrange: () => {
            arrangeResetOk({ emailVerifiedAt: null, phone: PHONE })
        },
        call: reset(),
        ok: { status: 'success', signInMethods: ['github'] },
        after: () => {
            expect(withTransactionMock).toHaveBeenCalledTimes(1)
            expect(resetRepositoryMock.markUsed).toHaveBeenCalledWith(11n, TX)
            expect(userRepositoryMock.update).toHaveBeenCalledTimes(1)
            expect(userRepositoryMock.update).toHaveBeenCalledWith(
                7n,
                {
                    emailVerifiedAt: expect.any(Date),
                    password: 'new-hash',
                    phone: null,
                    sessionToken: 'rotated-token',
                },
                TX,
            )
            expect(claimRepositoryMocks.oauthAccountRepository.deleteByUserId).toHaveBeenCalledWith(
                7n,
                TX,
            )
            expect(
                claimRepositoryMocks.pushSubscriptionRepository.deleteByUserId,
            ).toHaveBeenCalledWith(7n, TX)
            for (const repository of [
                claimRepositoryMocks.emailVerificationRepository,
                claimRepositoryMocks.emailLinkVerificationRepository,
                claimRepositoryMocks.oauthLinkVerificationRepository,
                resetRepositoryMock,
            ]) {
                expect(repository.invalidatePendingByUserId).toHaveBeenCalledWith(7n, TX)
            }
            // The claim retires the phone's challenges once, in the same transaction.
            expect(challengeRepositoryMock.invalidatePendingForPhoneFlow).toHaveBeenCalledTimes(2)
            expect(challengeRepositoryMock.invalidatePendingForPhoneFlow).toHaveBeenCalledWith(
                PHONE,
                'reset_phone',
                TX,
            )
            expect(challengeRepositoryMock.invalidatePendingForPhoneFlow).toHaveBeenCalledWith(
                PHONE,
                'link_phone',
                TX,
            )
            expect(destroyAllSessionsMock).toHaveBeenCalledWith('old-token')
            expect(securityNotice).toHaveBeenCalledTimes(1)
            expect(securityNotice).toHaveBeenCalledWith(7n, 'account_claimed')
        },
    },
    {
        name: 'resetPassword · a verified account is not claimed: phone, links and push stay',
        arrange: () => {
            arrangeResetOk({ phone: PHONE })
        },
        call: reset(),
        ok: { status: 'success', signInMethods: ['github'] },
        after: () => {
            expect(
                claimRepositoryMocks.oauthAccountRepository.deleteByUserId,
            ).not.toHaveBeenCalled()
            expect(
                claimRepositoryMocks.pushSubscriptionRepository.deleteByUserId,
            ).not.toHaveBeenCalled()
            expect(
                claimRepositoryMocks.emailVerificationRepository.invalidatePendingByUserId,
            ).not.toHaveBeenCalled()
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
        // feat-160: nothing is sent, so the hourly SMS budget of the number is not spent
        // either — only the per-address limit was counted.
        after: () => {
            expect(issueMock).not.toHaveBeenCalled()
            const policies = consumeAuthThrottleMock.mock.calls.map(
                ([policy]) => (policy as { name?: string }).name,
            )
            expect(policies).not.toContain('sms_send_phone')
            expect(consumeAuthThrottleMock).toHaveBeenCalledTimes(1)
        },
    },
    // feat-160 (decision Д5): after the cooldown the session that started the reset gets a new
    // code. It used to hand the waiting challenge back and send nothing, so a user
    // whose SMS never arrived could not get another one while that challenge was alive.
    {
        name: 'startPhonePasswordReset · after the cooldown a new code is sent and the waiting challenge is retired',
        arrange: () => {
            arrangeStartOk(phoneOnlyUser())
            challengeRepositoryMock.findLatestPendingForPhoneFlow.mockResolvedValue(challenge())
            challengeRepositoryMock.findPendingForPhoneFlow.mockResolvedValue([challenge()])
        },
        call: startPhone('sess-1'),
        ok: {
            message: GENERIC_PHONE,
            challengeId: 'ch-new',
            expiresAt: '2030-01-01T00:10:00.000Z',
            resendAvailableAt: '2030-01-01T00:01:00.000Z',
        },
        after: () => {
            expect(issueMock).toHaveBeenCalledWith({ phone: PHONE, flow: 'reset_phone' })
            // feat-204: only the session's own waiting challenge is retired.
            expect(challengeRepositoryMock.invalidatePendingByIds).toHaveBeenCalledWith(
                ['ch-1'],
                expect.anything(),
            )
            expect(challengeRepositoryMock.invalidatePendingForPhoneFlow).not.toHaveBeenCalled()
        },
    },
    // feat-204 (security review 2026-11-12, L-3). A live challenge used to block every other
    // session: the answer had no challenge, so whoever started first held the only one and the
    // owner could not use the codes that reached their phone. Another session now opens its
    // own challenge next to it; the one that was waiting stays, so nobody cancels a reset
    // they did not start (feat-160).
    {
        name: 'startPhonePasswordReset · another session gets a challenge of its own and the waiting one stays',
        arrange: () => {
            arrangeStartOk(phoneOnlyUser())
            challengeRepositoryMock.findLatestPendingForPhoneFlow.mockResolvedValue(challenge())
            challengeRepositoryMock.findPendingForPhoneFlow.mockResolvedValue([challenge()])
        },
        call: startPhone('other'),
        ok: {
            message: GENERIC_PHONE,
            challengeId: 'ch-new',
            expiresAt: '2030-01-01T00:10:00.000Z',
            resendAvailableAt: '2030-01-01T00:01:00.000Z',
        },
        after: () => {
            // Nothing of the other session is retired.
            expect(challengeRepositoryMock.invalidatePendingByIds).toHaveBeenCalledWith(
                [],
                expect.anything(),
            )
            expect(challengeRepositoryMock.invalidatePendingForPhoneFlow).not.toHaveBeenCalled()
            expect(challengeRepositoryMock.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    metadata: expect.objectContaining({ sessionId: 'other' }),
                }),
                expect.anything(),
            )
            expect(issueMock).toHaveBeenCalledWith({ phone: PHONE, flow: 'reset_phone' })
        },
    },
    {
        name: 'startPhonePasswordReset · a request without a session owns nothing: it opens next to a live challenge',
        arrange: () => {
            arrangeStartOk(phoneOnlyUser())
            challengeRepositoryMock.findPendingForPhoneFlow.mockResolvedValue([challenge()])
        },
        call: startPhone(null),
        ok: {
            message: GENERIC_PHONE,
            challengeId: 'ch-new',
            expiresAt: '2030-01-01T00:10:00.000Z',
            resendAvailableAt: '2030-01-01T00:01:00.000Z',
        },
        after: () => {
            expect(challengeRepositoryMock.invalidatePendingByIds).toHaveBeenCalledWith(
                [],
                expect.anything(),
            )
        },
    },
    {
        name: 'startPhonePasswordReset · two sessions already wait: a third gets the generic answer, nothing is sent and no SMS budget is spent',
        arrange: () => {
            userRepositoryMock.findByPhone.mockResolvedValue(phoneOnlyUser())
            challengeRepositoryMock.findPendingForPhoneFlow.mockResolvedValue([
                challenge({ id: 'ch-a', metadata: { userId: '7', sessionId: 'sess-a' } }),
                challenge({ id: 'ch-b', metadata: { userId: '7', sessionId: 'sess-b' } }),
            ])
        },
        call: startPhone('other'),
        ok: { message: GENERIC_PHONE },
        after: () => {
            expect(challengeRepositoryMock.create).not.toHaveBeenCalled()
            expect(challengeRepositoryMock.invalidatePendingByIds).not.toHaveBeenCalled()
            expect(issueMock).not.toHaveBeenCalled()
            const scopes = consumeAuthThrottleMock.mock.calls.map(
                ([policy]) => (policy as { scope?: string }).scope,
            )
            expect(scopes).not.toContain('sms_send_phone')
        },
    },
    {
        name: 'startPhonePasswordReset · one of the two waiting sessions starts again: it replaces its own, the other stays',
        arrange: () => {
            arrangeStartOk(phoneOnlyUser())
            challengeRepositoryMock.findPendingForPhoneFlow.mockResolvedValue([
                challenge({ id: 'ch-a', metadata: { userId: '7', sessionId: 'sess-a' } }),
                challenge({ id: 'ch-b', metadata: { userId: '7', sessionId: 'sess-b' } }),
            ])
        },
        call: startPhone('sess-b'),
        ok: {
            message: GENERIC_PHONE,
            challengeId: 'ch-new',
            expiresAt: '2030-01-01T00:10:00.000Z',
            resendAvailableAt: '2030-01-01T00:01:00.000Z',
        },
        after: () => {
            expect(challengeRepositoryMock.invalidatePendingByIds).toHaveBeenCalledWith(
                ['ch-b'],
                expect.anything(),
            )
        },
    },
    {
        name: 'startPhonePasswordReset · an expired leftover of another session does not count and is retired',
        arrange: () => {
            arrangeStartOk(phoneOnlyUser())
            challengeRepositoryMock.findPendingForPhoneFlow.mockResolvedValue([
                challenge({ id: 'ch-a', metadata: { userId: '7', sessionId: 'sess-a' } }),
                challenge({
                    id: 'ch-old',
                    expiresAt: PAST,
                    metadata: { userId: '7', sessionId: 'sess-b' },
                }),
            ])
        },
        call: startPhone('other'),
        ok: {
            message: GENERIC_PHONE,
            challengeId: 'ch-new',
            expiresAt: '2030-01-01T00:10:00.000Z',
            resendAvailableAt: '2030-01-01T00:01:00.000Z',
        },
        after: () => {
            expect(challengeRepositoryMock.invalidatePendingByIds).toHaveBeenCalledWith(
                ['ch-old'],
                expect.anything(),
            )
        },
    },
    // feat-204 (L-4): the code is sent after the answer, so the answer no longer waits for
    // the SMS provider (a number that gets an SMS used to answer later than one that does
    // not) and a failed send no longer changes it.
    {
        name: 'startPhonePasswordReset · the provider fails: the same answer, the challenge is invalidated, the failure logged',
        arrange: () => {
            arrangeStartOk(phoneOnlyUser())
            issueMock.mockRejectedValue(new Error('sms down'))
        },
        call: startPhone(),
        ok: {
            message: GENERIC_PHONE,
            challengeId: 'ch-new',
            expiresAt: '2030-01-01T00:10:00.000Z',
            resendAvailableAt: '2030-01-01T00:01:00.000Z',
        },
        after: () => {
            expect(challengeRepositoryMock.markInvalidated).toHaveBeenCalledWith('ch-new')
            expect(loggerMock.error).toHaveBeenCalledWith(
                expect.objectContaining({
                    err: expect.any(Error),
                    phoneMasked: expect.not.stringContaining('0501234'),
                }),
                'Phone reset code was not sent',
            )
        },
    },
    {
        name: 'startPhonePasswordReset · the issued code cannot be stored: the same answer, the challenge is invalidated',
        arrange: () => {
            arrangeStartOk(phoneOnlyUser())
            challengeRepositoryMock.markIssued.mockRejectedValue(new Error('db'))
        },
        call: startPhone(),
        ok: {
            message: GENERIC_PHONE,
            challengeId: 'ch-new',
            expiresAt: '2030-01-01T00:10:00.000Z',
            resendAvailableAt: '2030-01-01T00:01:00.000Z',
        },
        after: () => {
            expect(challengeRepositoryMock.markInvalidated).toHaveBeenCalledWith('ch-new')
            expect(loggerMock.error).toHaveBeenCalledTimes(1)
        },
    },
    {
        name: 'startPhonePasswordReset · the challenge was invalidated meanwhile: the same answer, a warning',
        arrange: () => {
            arrangeStartOk(phoneOnlyUser())
            challengeRepositoryMock.markIssued.mockResolvedValue(undefined)
        },
        call: startPhone(),
        ok: {
            message: GENERIC_PHONE,
            challengeId: 'ch-new',
            expiresAt: '2030-01-01T00:10:00.000Z',
            resendAvailableAt: '2030-01-01T00:01:00.000Z',
        },
        after: () => {
            expect(challengeRepositoryMock.markInvalidated).toHaveBeenCalledWith('ch-new')
            expect(loggerMock.warn).toHaveBeenCalledWith(
                expect.objectContaining({ phoneMasked: expect.any(String) }),
                'Phone reset code was not recorded: the challenge is no longer valid',
            )
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
                expect.anything(),
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
                expect.anything(),
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
    // feat-204 (security review 2026-11-12, L-4): a challenge allows a few wrong codes and a
    // number gets a few challenges an hour, for ever. The codes tried against one number in
    // a day have a budget a new challenge does not renew.
    {
        name: 'completePhonePasswordReset · the daily budget of code attempts of the number is spent: 429, no try of the challenge used',
        arrange: () => {
            arrangePhoneOk()
            consumeAuthThrottleMock.mockImplementation((policy: { scope: string }) =>
                Promise.resolve({
                    allowed: policy.scope !== 'reset_phone_code_attempts_phone',
                    count: 11,
                }),
            )
        },
        call: completePhone(),
        error: err(429, 'rate_limited', 'Too many verification attempts. Please try again later.'),
        after: () => {
            expect(consumeAuthThrottleMock).toHaveBeenCalledWith(
                expect.objectContaining({ scope: 'reset_phone_code_attempts_phone' }),
                PHONE,
            )
            expect(challengeRepositoryMock.consumeAttempt).not.toHaveBeenCalled()
            expect(userRepositoryMock.update).not.toHaveBeenCalled()
        },
    },
    {
        name: 'completePhonePasswordReset · wrong code counts an attempt',
        arrange: () => {
            challengeRepositoryMock.findById.mockResolvedValue(challenge())
        },
        call: completePhone('000000'),
        error: badRequest('Invalid verification code'),
        after: () => {
            expect(challengeRepositoryMock.consumeAttempt).toHaveBeenCalledWith(
                'ch-1',
                3,
                undefined,
            )
            expect(challengeRepositoryMock.markInvalidatedIfPending).not.toHaveBeenCalled()
        },
    },
    {
        name: 'completePhonePasswordReset · the last wrong attempt invalidates the challenge',
        arrange: () => {
            challengeRepositoryMock.findById.mockResolvedValue(challenge({ attemptCount: 2 }))
        },
        call: completePhone('000000'),
        error: badRequest('Invalid verification code'),
        after: () => {
            expect(challengeRepositoryMock.markInvalidatedIfPending).toHaveBeenCalledWith(
                'ch-1',
                undefined,
            )
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
            userRepositoryMock.lockById.mockResolvedValue(user({ phone: PHONE }))
        },
        call: completePhone(),
        error: badRequest('Phone reset challenge is invalid'),
    },
    {
        name: 'completePhonePasswordReset · the account has another phone now',
        arrange: () => {
            challengeRepositoryMock.findById.mockResolvedValue(challenge())
            userRepositoryMock.lockById.mockResolvedValue(phoneOnlyUser({ phone: '+380509999999' }))
        },
        call: completePhone(),
        error: badRequest('Phone reset challenge is invalid'),
    },
    {
        name: 'completePhonePasswordReset · the user is gone',
        arrange: () => {
            challengeRepositoryMock.findById.mockResolvedValue(challenge())
            userRepositoryMock.lockById.mockResolvedValue(undefined)
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
        ok: { status: 'success', signInMethods: ['github'] },
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
        ok: { status: 'success', signInMethods: ['github'] },
        after: () => {
            expect(userRepositoryMock.update).toHaveBeenCalledWith(
                7n,
                { password: 'new-hash', sessionToken: 'rotated-token' },
                TX,
            )
            expect(destroyAllSessionsMock).toHaveBeenCalledWith('old-token')
            expect(challengeRepositoryMock.invalidatePendingForPhoneFlow).toHaveBeenCalledWith(
                PHONE,
                'reset_phone',
                TX,
            )
            expect(challengeRepositoryMock.markConfirmed).toHaveBeenCalledWith('ch-1', TX)
            expect(resetRepositoryMock.invalidatePendingByUserId).toHaveBeenCalledWith(7n, TX)
            expect(securityNotice).toHaveBeenCalledWith(7n, 'password_reset')
            // feat-204: the owner proved the number, the day's budget of code attempts is cleared.
            expect(resetAuthThrottleMock).toHaveBeenCalledWith(
                expect.objectContaining({ scope: 'reset_phone_code_attempts_phone' }),
                PHONE,
            )
        },
    },
    {
        name: 'completePhonePasswordReset · the attempts budget cannot be cleared: the reset stands',
        arrange: () => {
            arrangePhoneOk()
            resetAuthThrottleMock.mockRejectedValue(new Error('redis down'))
        },
        call: completePhone(),
        ok: { status: 'success', signInMethods: ['github'] },
        after: () => {
            expect(loggerMock.warn).toHaveBeenCalledWith(
                expect.objectContaining({ err: expect.any(Error) }),
                'Phone reset code attempts budget was not cleared',
            )
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
        // ADR 0004: an infrastructure failure is not an AppError; it propagates to the transport.
        if (row.throws === true) {
            await expect(row.call(passwordResetService)).rejects.toBeInstanceOf(Error)
        } else {
            const result = (await row.call(passwordResetService)) as Result<unknown, AppError>

            if (row.error === undefined) {
                expect(
                    Result.isOk(result),
                    JSON.stringify(Result.isError(result) && result.error),
                ).toBe(true)
                if (Result.isOk(result) && row.ok !== undefined)
                    expect(result.value).toEqual(row.ok)
            } else {
                expect(Result.isError(result)).toBe(true)
                if (Result.isError(result)) expect(describeError(result.error)).toEqual(row.error)
            }
        }
        // requestPasswordReset sends its mail from a detached promise: let it settle.
        await new Promise((resolve) => setImmediate(resolve))
        row.after?.()
    })
})

describe('passwordResetService · sendPasswordResetEmailInBackground', () => {
    it('logs a failed send as a warning with the reason and the trigger, and does not throw', async () => {
        userRepositoryMock.lockById.mockResolvedValue(undefined)
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
        userRepositoryMock.lockById.mockResolvedValue(user())
        resetRepositoryMock.create.mockResolvedValue({ id: 1n })
        emailServiceMock.send.mockResolvedValue(Result.ok(undefined))
        const { passwordResetService } = await import('./password-reset-service.js')
        await passwordResetService.sendPasswordResetEmailInBackground(7n, 'manual request')
        expect(loggerMock.warn).not.toHaveBeenCalled()
        expect(loggerMock.error).not.toHaveBeenCalled()
    })
})
