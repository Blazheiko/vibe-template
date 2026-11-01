import { Result } from 'better-result'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    appErrorCode,
    appErrorMessage,
    appErrorStatus,
    type AppError,
} from '#app/services/shared/errors.js'
import type { emailVerificationService } from './email-verification-service.js'

// feat-069 (G1): emailVerificationService, state -> answer, before it is split (H2-H5). Every
// row names a state of the repositories and what the caller is told or gets back, and the side
// effects that must or must not have happened. The throttle steps are in
// email-verification-service.throttle-contract.spec.ts; the mails are frozen in
// auth-email-templates.snapshot.spec.ts.

const userRepositoryMock = { findById: vi.fn(), findByEmail: vi.fn(), update: vi.fn() }
const verificationRepositoryMock = {
    create: vi.fn(),
    findByTokenHash: vi.fn(),
    invalidatePendingByUserId: vi.fn(),
    markUsed: vi.fn(),
}
const linkRepositoryMock = {
    create: vi.fn(),
    findByTokenHash: vi.fn(),
    invalidatePendingByUserId: vi.fn(),
    markUsed: vi.fn(),
}
const emailServiceMock = { send: vi.fn() }
const consumeAuthThrottleMock = vi.fn()
const loggerMock = { warn: vi.fn(), error: vi.fn(), info: vi.fn() }
const TX = vi.hoisted(() => ({ transaction: true }))
const withTransactionMock = vi.fn(<T>(work: (tx: unknown) => Promise<T>): Promise<T> => work(TX))

vi.mock('#app/repositories/index.js', () => ({
    userRepository: userRepositoryMock,
    emailVerificationRepository: verificationRepositoryMock,
    emailLinkVerificationRepository: linkRepositoryMock,
    withTransaction: (work: (tx: unknown) => Promise<unknown>) => withTransactionMock(work),
}))
vi.mock('#app/services/notifications/email-service.js', () => ({ emailService: emailServiceMock }))
vi.mock('#app/services/auth/auth-throttle-service.js', () => ({
    consumeAuthThrottle: consumeAuthThrottleMock,
}))
vi.mock('#logger', () => ({ default: loggerMock }))

const originalEnv = { ...process.env }
const FUTURE = new Date(Date.now() + 600_000)
const PAST = new Date(Date.now() - 1000)
const IP = { ipAddress: '203.0.113.9' }

beforeEach(() => {
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

type Service = typeof emailVerificationService

interface Expected {
    status: number
    code: string
    message: string
}
interface Row {
    name: string
    arrange?: () => void
    call: (service: Service) => Promise<unknown>
    error?: Expected
    ok?: unknown
    after?: () => void
}

const err = (status: number, code: string, message: string): Expected => ({
    status,
    code,
    message,
})
const badRequest = (message: string): Expected => err(400, 'bad_request', message)
const internalError = (message: string): Expected => err(500, 'internal_error', message)

const user = (over: Record<string, unknown> = {}) => ({
    id: 7n,
    name: 'Jane',
    email: 'jane@example.com',
    emailVerifiedAt: null,
    ...over,
})
const record = (over: Record<string, unknown> = {}) => ({
    id: 11n,
    userId: 7n,
    usedAt: null,
    expiresAt: FUTURE,
    ...over,
})
const linkRecord = (over: Record<string, unknown> = {}) =>
    record({ targetEmail: 'New@Example.com', ...over })

const verify =
    (token = 'tok') =>
    (s: Service) =>
        s.verifyEmail(token, IP)

/** A verification token (not a link token) that is found, and a user to confirm. */
function arrangeVerify(over: Record<string, unknown> = {}): void {
    verificationRepositoryMock.findByTokenHash.mockResolvedValue(record())
    userRepositoryMock.findById.mockResolvedValue(user(over))
    verificationRepositoryMock.markUsed.mockResolvedValue(record())
    userRepositoryMock.update.mockResolvedValue(user())
}
/** No verification token, but a link token. */
function arrangeLink(): void {
    verificationRepositoryMock.findByTokenHash.mockResolvedValue(undefined)
    linkRepositoryMock.findByTokenHash.mockResolvedValue(linkRecord())
    userRepositoryMock.findById.mockResolvedValue(user({ email: null }))
    userRepositoryMock.findByEmail.mockResolvedValue(undefined)
    linkRepositoryMock.markUsed.mockResolvedValue(linkRecord())
    userRepositoryMock.update.mockResolvedValue(user())
}

const ROWS: readonly Row[] = [
    // --- sendVerificationEmail --------------------------------------------------------------
    {
        name: 'sendVerificationEmail · unknown user',
        arrange: () => userRepositoryMock.findById.mockResolvedValue(undefined),
        call: (s) => s.sendVerificationEmail(7n),
        error: err(404, 'not_found', 'User not found'),
    },
    {
        name: 'sendVerificationEmail · already verified: nothing is made, nothing is sent',
        arrange: () =>
            userRepositoryMock.findById.mockResolvedValue(user({ emailVerifiedAt: new Date() })),
        call: (s) => s.sendVerificationEmail(7n),
        ok: { message: 'Email is already verified' },
        after: () => {
            expect(verificationRepositoryMock.invalidatePendingByUserId).not.toHaveBeenCalled()
            expect(emailServiceMock.send).not.toHaveBeenCalled()
        },
    },
    {
        name: 'sendVerificationEmail · earlier tokens are invalidated first',
        arrange: () => {
            userRepositoryMock.findById.mockResolvedValue(user())
            verificationRepositoryMock.invalidatePendingByUserId.mockRejectedValue(new Error('db'))
        },
        call: (s) => s.sendVerificationEmail(7n),
        error: internalError('Failed to invalidate email verification tokens'),
        after: () => {
            expect(verificationRepositoryMock.create).not.toHaveBeenCalled()
        },
    },
    {
        name: 'sendVerificationEmail · the token cannot be stored',
        arrange: () => {
            userRepositoryMock.findById.mockResolvedValue(user())
            verificationRepositoryMock.create.mockRejectedValue(new Error('db'))
        },
        call: (s) => s.sendVerificationEmail(7n),
        error: internalError('Failed to create email verification token'),
        after: () => {
            expect(emailServiceMock.send).not.toHaveBeenCalled()
        },
    },
    {
        name: 'sendVerificationEmail · an account without an e-mail',
        arrange: () => {
            userRepositoryMock.findById.mockResolvedValue(user({ email: null }))
            verificationRepositoryMock.create.mockResolvedValue({ id: 1n })
        },
        call: (s) => s.sendVerificationEmail(7n),
        error: badRequest('Email verification requires an email address'),
        after: () => {
            expect(emailServiceMock.send).not.toHaveBeenCalled()
        },
    },
    {
        name: 'sendVerificationEmail · the transport fails',
        arrange: () => {
            userRepositoryMock.findById.mockResolvedValue(user())
            verificationRepositoryMock.create.mockResolvedValue({ id: 1n })
            emailServiceMock.send.mockResolvedValue(Result.err(new Error('smtp')))
        },
        call: (s) => s.sendVerificationEmail(7n),
        error: internalError('Failed to send verification email'),
    },
    {
        name: 'sendVerificationEmail · sent: only the hash of the token is stored, for 24 hours',
        arrange: () => {
            userRepositoryMock.findById.mockResolvedValue(user())
            verificationRepositoryMock.create.mockResolvedValue({ id: 1n })
            emailServiceMock.send.mockResolvedValue(Result.ok(undefined))
        },
        call: (s) => s.sendVerificationEmail(7n),
        ok: { message: 'Verification email sent' },
        after: () => {
            const created = verificationRepositoryMock.create.mock.calls[0]![0] as {
                userId: bigint
                tokenHash: string
                expiresAt: Date
            }
            const mail = emailServiceMock.send.mock.calls[0]![0] as { to: string; text: string }
            const raw = /token=([\w-]+)/.exec(mail.text)![1]!
            expect(mail.to).toBe('jane@example.com')
            expect(mail.text).toContain(`https://app.example.com/verify-email?token=${raw}`)
            expect(created.userId).toBe(7n)
            expect(created.tokenHash).toMatch(/^[0-9a-f]{64}$/)
            expect(created.tokenHash).not.toContain(raw)
            expect(created.expiresAt.getTime() - Date.now()).toBeGreaterThan(23 * 3_600_000)
            expect(created.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(24 * 3_600_000)
        },
    },
    // --- sendLinkVerificationEmail ----------------------------------------------------------
    {
        name: 'sendLinkVerificationEmail · unknown user',
        arrange: () => userRepositoryMock.findById.mockResolvedValue(undefined),
        call: (s) => s.sendLinkVerificationEmail(7n, 'new@example.com'),
        error: err(404, 'not_found', 'User not found'),
    },
    {
        name: 'sendLinkVerificationEmail · earlier link tokens are invalidated first',
        arrange: () => {
            userRepositoryMock.findById.mockResolvedValue(user())
            linkRepositoryMock.invalidatePendingByUserId.mockRejectedValue(new Error('db'))
        },
        call: (s) => s.sendLinkVerificationEmail(7n, 'new@example.com'),
        error: internalError('Failed to invalidate email link tokens'),
        after: () => {
            expect(linkRepositoryMock.create).not.toHaveBeenCalled()
        },
    },
    {
        name: 'sendLinkVerificationEmail · the token cannot be stored',
        arrange: () => {
            userRepositoryMock.findById.mockResolvedValue(user())
            linkRepositoryMock.create.mockRejectedValue(new Error('db'))
        },
        call: (s) => s.sendLinkVerificationEmail(7n, 'new@example.com'),
        error: internalError('Failed to create email link token'),
    },
    {
        name: 'sendLinkVerificationEmail · the transport fails',
        arrange: () => {
            userRepositoryMock.findById.mockResolvedValue(user())
            linkRepositoryMock.create.mockResolvedValue({ id: 1n })
            emailServiceMock.send.mockResolvedValue(Result.err(new Error('smtp')))
        },
        call: (s) => s.sendLinkVerificationEmail(7n, 'new@example.com'),
        error: internalError('Failed to send email link verification'),
    },
    {
        name: 'sendLinkVerificationEmail · the mail goes to the NEW address, the token remembers it',
        arrange: () => {
            userRepositoryMock.findById.mockResolvedValue(user({ email: null }))
            linkRepositoryMock.create.mockResolvedValue({ id: 1n })
            emailServiceMock.send.mockResolvedValue(Result.ok(undefined))
        },
        call: (s) => s.sendLinkVerificationEmail(7n, 'new@example.com'),
        ok: { message: 'Verification email will be sent shortly' },
        after: () => {
            expect(linkRepositoryMock.create).toHaveBeenCalledWith(
                expect.objectContaining({ userId: 7n, targetEmail: 'new@example.com' }),
            )
            expect(emailServiceMock.send).toHaveBeenCalledWith(
                expect.objectContaining({ to: 'new@example.com' }),
            )
        },
    },
    // --- verifyEmail: the registration token ------------------------------------------------
    {
        name: 'verifyEmail · blank token, after the counter is spent',
        call: verify('   '),
        error: badRequest('Verification token is required'),
        after: () => {
            expect(consumeAuthThrottleMock).toHaveBeenCalledTimes(1)
        },
    },
    {
        name: 'verifyEmail · a token nobody knows',
        arrange: () => {
            verificationRepositoryMock.findByTokenHash.mockResolvedValue(undefined)
            linkRepositoryMock.findByTokenHash.mockResolvedValue(undefined)
        },
        call: verify(),
        error: badRequest('Verification link is invalid'),
    },
    {
        name: 'verifyEmail · the token has been used',
        arrange: () =>
            verificationRepositoryMock.findByTokenHash.mockResolvedValue(
                record({ usedAt: new Date() }),
            ),
        call: verify(),
        error: badRequest('Verification link has already been used'),
    },
    {
        name: 'verifyEmail · the token has expired and is burnt',
        arrange: () =>
            verificationRepositoryMock.findByTokenHash.mockResolvedValue(
                record({ expiresAt: PAST }),
            ),
        call: verify(),
        error: badRequest('Verification link has expired'),
        after: () => {
            expect(verificationRepositoryMock.markUsed).toHaveBeenCalledWith(11n)
            expect(userRepositoryMock.update).not.toHaveBeenCalled()
        },
    },
    {
        name: 'verifyEmail · the user is gone',
        arrange: () => {
            verificationRepositoryMock.findByTokenHash.mockResolvedValue(record())
            userRepositoryMock.findById.mockResolvedValue(undefined)
        },
        call: verify(),
        error: err(404, 'not_found', 'User not found'),
    },
    {
        name: 'verifyEmail · the claim is lost to a concurrent request',
        arrange: () => {
            arrangeVerify()
            verificationRepositoryMock.markUsed.mockResolvedValue(undefined)
        },
        call: verify(),
        error: badRequest('Verification link has already been used'),
        after: () => {
            expect(userRepositoryMock.update).not.toHaveBeenCalled()
        },
    },
    {
        name: 'verifyEmail · a failure inside the transaction fails the request',
        arrange: () => {
            arrangeVerify()
            userRepositoryMock.update.mockResolvedValue(undefined)
        },
        call: verify(),
        error: internalError('Failed to verify email'),
    },
    {
        name: 'verifyEmail · ok claims the token and confirms the address in one transaction',
        arrange: () => {
            arrangeVerify()
        },
        call: verify(' tok '),
        ok: { message: 'Email confirmed successfully' },
        after: () => {
            expect(withTransactionMock).toHaveBeenCalledTimes(1)
            expect(verificationRepositoryMock.markUsed).toHaveBeenCalledWith(11n, undefined, TX)
            expect(userRepositoryMock.update).toHaveBeenCalledWith(
                7n,
                { emailVerifiedAt: expect.any(Date) },
                TX,
            )
        },
    },
    {
        name: 'verifyEmail · an already verified account only has its token burnt',
        arrange: () => {
            arrangeVerify({ emailVerifiedAt: new Date() })
        },
        call: verify(),
        ok: { message: 'Email confirmed successfully' },
        after: () => {
            expect(verificationRepositoryMock.markUsed).toHaveBeenCalledWith(11n, undefined, TX)
            expect(userRepositoryMock.update).not.toHaveBeenCalled()
        },
    },
    // --- verifyEmail: the link token --------------------------------------------------------
    {
        name: 'verifyEmail · a link token that has been used',
        arrange: () => {
            arrangeLink()
            linkRepositoryMock.findByTokenHash.mockResolvedValue(linkRecord({ usedAt: new Date() }))
        },
        call: verify(),
        error: badRequest('Verification link has already been used'),
    },
    {
        name: 'verifyEmail · a link token that has expired is burnt',
        arrange: () => {
            arrangeLink()
            linkRepositoryMock.findByTokenHash.mockResolvedValue(linkRecord({ expiresAt: PAST }))
        },
        call: verify(),
        error: badRequest('Verification link has expired'),
        after: () => {
            expect(linkRepositoryMock.markUsed).toHaveBeenCalledWith(11n)
        },
    },
    {
        name: 'verifyEmail · the link token user is gone',
        arrange: () => {
            arrangeLink()
            userRepositoryMock.findById.mockResolvedValue(undefined)
        },
        call: verify(),
        error: err(404, 'not_found', 'User not found'),
    },
    {
        name: 'verifyEmail · the address got taken by another account meanwhile',
        arrange: () => {
            arrangeLink()
            userRepositoryMock.findByEmail.mockResolvedValue(user({ id: 99n }))
        },
        call: verify(),
        error: err(409, 'conflict', 'Email is already linked to another account'),
        after: () => {
            expect(linkRepositoryMock.markUsed).not.toHaveBeenCalled()
        },
    },
    {
        name: 'verifyEmail · the unique index decides the race: 409, not 500',
        arrange: () => {
            arrangeLink()
            userRepositoryMock.update.mockRejectedValue(
                Object.assign(new Error('duplicate key'), { code: '23505' }),
            )
        },
        call: verify(),
        error: err(409, 'conflict', 'Email is already linked to another account'),
    },
    {
        name: 'verifyEmail · any other failure of the link transaction stays a 500',
        arrange: () => {
            arrangeLink()
            userRepositoryMock.update.mockRejectedValue(new Error('db'))
        },
        call: verify(),
        error: internalError('Failed to link email'),
    },
    {
        name: 'verifyEmail · the claim of a link token is lost to a concurrent request',
        arrange: () => {
            arrangeLink()
            linkRepositoryMock.markUsed.mockResolvedValue(undefined)
        },
        call: verify(),
        error: badRequest('Verification link has already been used'),
        after: () => {
            expect(userRepositoryMock.update).not.toHaveBeenCalled()
        },
    },
    {
        name: 'verifyEmail · a link token links the lower-cased address, verified, in one transaction',
        arrange: () => {
            arrangeLink()
        },
        call: verify(),
        ok: { message: 'Email linked successfully' },
        after: () => {
            expect(userRepositoryMock.findByEmail).toHaveBeenCalledWith('new@example.com')
            expect(linkRepositoryMock.markUsed).toHaveBeenCalledWith(11n, undefined, TX)
            expect(userRepositoryMock.update).toHaveBeenCalledWith(
                7n,
                { email: 'new@example.com', emailVerifiedAt: expect.any(Date) },
                TX,
            )
        },
    },
    // --- queueVerificationEmail -------------------------------------------------------------
    {
        name: 'queueVerificationEmail · unknown user',
        arrange: () => userRepositoryMock.findById.mockResolvedValue(undefined),
        call: (s) => s.queueVerificationEmail(7n),
        error: err(404, 'not_found', 'User not found'),
    },
    {
        name: 'queueVerificationEmail · already verified',
        arrange: () =>
            userRepositoryMock.findById.mockResolvedValue(user({ emailVerifiedAt: new Date() })),
        call: (s) => s.queueVerificationEmail(7n),
        ok: { message: 'Email is already verified' },
        after: () => {
            expect(emailServiceMock.send).not.toHaveBeenCalled()
        },
    },
    {
        name: 'queueVerificationEmail · answers at once, the mail goes out in the background',
        arrange: () => {
            userRepositoryMock.findById.mockResolvedValue(user())
            verificationRepositoryMock.create.mockResolvedValue({ id: 1n })
            emailServiceMock.send.mockResolvedValue(Result.ok(undefined))
        },
        call: (s) => s.queueVerificationEmail(7n),
        ok: { message: 'Verification email will be sent shortly' },
        after: () => {
            expect(emailServiceMock.send).toHaveBeenCalledTimes(1)
        },
    },
]

function describeError(error: AppError): Expected {
    return {
        status: appErrorStatus(error),
        code: appErrorCode(error),
        message: appErrorMessage(error),
    }
}

async function load(): Promise<Service> {
    return (await import('./email-verification-service.js')).emailVerificationService
}

describe.each(ROWS)('emailVerificationService · $name', (row) => {
    it('answers as the table says and leaves the stated side effects', async () => {
        row.arrange?.()
        const result = (await row.call(await load())) as Result<unknown, AppError>

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
        // queueVerificationEmail sends from a detached promise: let it settle.
        await new Promise((resolve) => setImmediate(resolve))
        row.after?.()
    })
})

describe('emailVerificationService · the background senders', () => {
    it('log a failed send as a warning with the reason and the trigger, and do not throw', async () => {
        userRepositoryMock.findById.mockResolvedValue(undefined)
        const service = await load()
        await expect(
            service.sendVerificationEmailInBackground(7n, 'manual resend'),
        ).resolves.toBeUndefined()
        expect(loggerMock.warn).toHaveBeenCalledWith(
            { userId: '7', reason: 'User not found', trigger: 'manual resend' },
            'Failed to send verification email in background',
        )
    })

    it('log an unexpected throw as an error and do not throw', async () => {
        const boom = new Error('boom')
        const service = await load()
        vi.spyOn(service, 'sendVerificationEmail').mockRejectedValue(boom)
        await expect(
            service.sendVerificationEmailInBackground(7n, 'unverified login'),
        ).resolves.toBeUndefined()
        expect(loggerMock.error).toHaveBeenCalledWith(
            { err: boom, userId: '7', trigger: 'unverified login' },
            'Unexpected error while sending verification email in background',
        )
    })

    it('after registration tell the log why the mail was sent', async () => {
        userRepositoryMock.findById.mockResolvedValue(undefined)
        const service = await load()
        await service.sendVerificationEmailAfterRegistration(7n)
        expect(loggerMock.warn).toHaveBeenCalledWith(
            expect.objectContaining({ trigger: 'registration' }),
            'Failed to send verification email in background',
        )
    })
})
