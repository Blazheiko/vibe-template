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
import type { authService } from './auth-service.js'

// feat-129: the session-still-stored guard is required; these cases keep the session.
const sessionStillStored = (): Promise<boolean> => Promise.resolve(true)

// feat-069 (G1): authService, state -> answer. Every row names a state of the repositories or
// of the session and what the caller is told (status, code, message) and what has been done
// by then (the writes and the side effects). H1-H5 move code between files and must not
// change a row. The throttle steps are in auth-service.throttle-contract.spec.ts.

const userRepositoryMock = {
    findByEmail: vi.fn(),
    findByPhone: vi.fn(),
    findById: vi.fn(),
    emailExistsForOtherUser: vi.fn(),
    phoneExistsForOtherUser: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateIfSessionToken: vi.fn(),
    findSessionToken: vi.fn(),
    changePasswordIfCurrent: vi.fn(),
}
const challengeRepositoryMock = {
    create: vi.fn(),
    findById: vi.fn(),
    findLatestPendingForPhoneFlow: vi.fn(),
    invalidatePendingForPhoneFlow: vi.fn(),
    consumeAttempt: vi.fn(),
    markInvalidatedIfPending: vi.fn(),
    markConfirmed: vi.fn(),
    markInvalidated: vi.fn(),
    markIssued: vi.fn(),
}
const authMock = {
    login: vi.fn(),
    logout: vi.fn(),
    logoutAll: vi.fn(() => Promise.resolve({ deleted: 0, complete: true })),
    getUserId: vi.fn(),
    getPresentedUserToken: vi.fn(),
}
const sessionMock = {
    sessionInfo: { id: 'session-id', data: {} } as {
        id: string
        data: Record<string, unknown>
    } | null,
    destroySession: vi.fn(),
}
const loggerMock = { warn: vi.fn(), info: vi.fn(), error: vi.fn() }
const validatePasswordMock = vi.fn()
const hashPasswordMock = vi.fn()
const consumeAuthThrottleMock = vi.fn()
const resetAuthThrottleMock = vi.fn()
const destroyAllSessionsMock = vi.fn(() => Promise.resolve({ deleted: 0, complete: true }))
const securityNotice = vi.fn()
const generateWsTokenMock = vi.fn()
const issueMock = vi.fn()

vi.mock('#app/repositories/index.js', () => ({
    // feat-109: change-password and logout-all retire the pending reset links.
    passwordResetRepository: { invalidatePendingByUserId: vi.fn().mockResolvedValue(0) },
    userRepository: userRepositoryMock,
    smsAuthChallengeRepository: challengeRepositoryMock,
    withTransaction: <T>(work: (tx: unknown) => Promise<T>): Promise<T> => work({}),
}))
vi.mock('#app/transformers/index.js', () => ({
    userTransformer: { serialize: vi.fn((u: { id: bigint }) => ({ id: String(u.id) })) },
}))
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
vi.mock('#app/services/notifications/user-notification-service.js', () => ({
    userNotificationService: { security: securityNotice, supportReply: vi.fn() },
}))
vi.mock('#app/services/auth/email-verification-service.js', () => ({
    emailVerificationService: {
        sendVerificationEmailAfterRegistration: vi.fn(),
        sendLinkVerificationEmail: vi.fn(),
        sendVerificationEmailInBackground: vi.fn(),
    },
}))
vi.mock('#app/services/auth/sms-verification-provider.js', () => ({
    smsVerificationProvider: { issueVerificationCode: issueMock },
}))
vi.mock('#app/services/auth/auth-throttle-service.js', () => ({
    consumeAuthThrottle: consumeAuthThrottleMock,
    resetAuthThrottle: resetAuthThrottleMock,
}))
vi.mock('nanoid', () => ({ nanoid: () => 'rotated-token' }))
vi.mock('#logger', () => ({ default: loggerMock }))

const originalEnv = { ...process.env }
const SECRET = 'a'.repeat(32)
const otp = (code: string): string => createHmac('sha256', SECRET).update(code).digest('hex')
const FUTURE = new Date(Date.now() + 600_000)
const PAST = new Date(Date.now() - 1000)
const IP = { ipAddress: '203.0.113.9' }
const CSRF = 'c'.repeat(43)
/** The user token the request presented; account() below still holds it (feat-096). */
const TOKEN = 'old-token'

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
    consumeAuthThrottleMock.mockResolvedValue({ allowed: true, count: 1 })
    resetAuthThrottleMock.mockResolvedValue(undefined)
    sessionMock.sessionInfo = { id: 'session-id', data: { csrfToken: CSRF } }
    authMock.getPresentedUserToken.mockReturnValue(TOKEN)
})

afterEach(() => {
    vi.resetModules()
    vi.resetAllMocks()
    for (const key of Object.keys(process.env)) {
        if (!(key in originalEnv)) delete process.env[key]
    }
    Object.assign(process.env, originalEnv)
})

const challenge = (over: Record<string, unknown> = {}) => ({
    id: 'ch-1',
    flow: 'register_phone',
    phone: '+380501234567',
    codeHash: otp('123456'),
    attemptCount: 0,
    expiresAt: FUTURE,
    invalidatedAt: null,
    confirmedAt: null,
    metadata: { sessionId: 'sess-1', userId: '7' },
    ...over,
})
const linkChallenge = (over: Record<string, unknown> = {}) =>
    challenge({ flow: 'link_phone', ...over })

type Service = typeof authService

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
    /** Side effects that must have happened / not happened, checked after the call. */
    after?: () => void
}

const err = (status: number, code: string, message: string, reason?: string): Expected => ({
    status,
    code,
    message,
    ...(reason === undefined ? {} : { reason }),
})
const badRequest = (message: string): Expected => err(400, 'bad_request', message)
const internalError = (message: string): Expected => err(500, 'internal_error', message)
const SESSION_REVOKED = err(401, 'unauthorized', 'Session has been revoked', 'session_revoked')

const confirmReg =
    (code = '123456') =>
    (s: Service) =>
        s.confirmPhoneRegistration({ challengeId: 'ch-1', code }, IP)
const startReg = (s: Service) =>
    s.startPhoneRegistration({ phone: '+380501234567' }, { ...IP, sessionId: 's' })
const issued = () => ({
    id: 'ch-new',
    expiresAt: new Date('2030-01-01T00:10:00Z'),
    resendAvailableAt: new Date('2030-01-01T00:01:00Z'),
})
function arrangeIssued(): void {
    challengeRepositoryMock.create.mockResolvedValue({ id: 'ch-new' })
    issueMock.mockResolvedValue({ code: '123456', providerRequestId: 'p-1' })
    challengeRepositoryMock.markIssued.mockResolvedValue(issued())
}
function arrangeLinkStart(): void {
    userRepositoryMock.findById.mockResolvedValue(account())
    validatePasswordMock.mockResolvedValue(true)
    userRepositoryMock.phoneExistsForOtherUser.mockResolvedValue(false)
    challengeRepositoryMock.create.mockResolvedValue({ id: 'ch-new' })
}
const completeReg = (s: Service) =>
    s.completePhoneRegistration(
        { challengeId: 'ch-1', name: 'Jane', password: 'secret-pass' } as never,
        authMock as never,
        sessionMock as never,
        loggerMock as never,
        { sessionId: 'sess-1' },
    )
const confirmLink =
    (code = '123456', sessionId: string | null = 'sess-1') =>
    (s: Service) =>
        s.confirmPhoneLink(
            7n,
            { challengeId: 'ch-1', code },
            { ...IP, sessionId, presentedSessionToken: TOKEN, sessionStored: sessionStillStored },
        )
// feat-096: the same calls as a session presenting `presented` (undefined: none at all).
const confirmLinkAs = (presented: string | undefined) => (s: Service) =>
    s.confirmPhoneLink(
        7n,
        { challengeId: 'ch-1', code: '123456' },
        {
            ...IP,
            sessionId: 'sess-1',
            presentedSessionToken: presented,
            sessionStored: sessionStillStored,
        },
    )
const startLinkAs = (presented: string | undefined) => (s: Service) =>
    s.startPhoneLink(
        7n,
        { phone: '+380501234567', currentPassword: 'secret' },
        {
            ...IP,
            sessionId: 'sess-1',
            presentedSessionToken: presented,
            sessionStored: sessionStillStored,
        },
    )
const startLink = startLinkAs(TOKEN)
const startEmailAs = (presented: string | undefined) => (s: Service) =>
    s.startEmailLink(
        7n,
        { email: 'new@example.com', currentPassword: 'secret' },
        presented,
        sessionStillStored,
    )
const startEmail = startEmailAs(TOKEN)
const changeAs =
    (presented: string | undefined, payload: Record<string, unknown>) => (s: Service) =>
        s.changePassword(7n, payload as never, presented)
const change = (payload: Record<string, unknown>) => changeAs(TOKEN, payload)

const account = (over: Record<string, unknown> = {}) => ({
    id: 7n,
    email: null,
    phone: null,
    password: 'stored-hash',
    sessionToken: 'old-token',
    ...over,
})

const ROWS: readonly Row[] = [
    // --- phone registration, step 1: issue a code --------------------------------------------
    {
        name: 'startPhoneRegistration · phone login disabled',
        arrange: () => {
            process.env['AUTH_PHONE_ENABLED'] = 'false'
        },
        call: startReg,
        error: badRequest('Phone authentication is disabled'),
        after: () => {
            expect(consumeAuthThrottleMock).not.toHaveBeenCalled()
        },
    },
    {
        name: 'startPhoneRegistration · invalid phone',
        call: (s) => s.startPhoneRegistration({ phone: 'nope' }, { ...IP, sessionId: 's' }),
        error: badRequest('Phone number must be valid and in a supported format'),
        after: () => {
            expect(consumeAuthThrottleMock).not.toHaveBeenCalled()
        },
    },
    {
        name: 'startPhoneRegistration · a code was sent a moment ago',
        arrange: () =>
            challengeRepositoryMock.findLatestPendingForPhoneFlow.mockResolvedValue({
                resendAvailableAt: new Date(Date.now() + 30_000),
            }),
        call: startReg,
        error: err(
            429,
            'rate_limited',
            'A verification code was already sent recently. Please wait before requesting another one.',
            'resend_cooldown_active',
        ),
        after: () => {
            expect(challengeRepositoryMock.create).not.toHaveBeenCalled()
        },
    },
    {
        name: 'startPhoneRegistration · the provider fails, the challenge is invalidated',
        arrange: () => {
            challengeRepositoryMock.create.mockResolvedValue({ id: 'ch-new' })
            issueMock.mockRejectedValue(new Error('sms down'))
        },
        call: startReg,
        throws: true,
        after: () => {
            expect(challengeRepositoryMock.markInvalidated).toHaveBeenCalledWith('ch-new')
        },
    },
    {
        name: 'startPhoneRegistration · the issued code cannot be stored',
        arrange: () => {
            challengeRepositoryMock.create.mockResolvedValue({ id: 'ch-new' })
            issueMock.mockResolvedValue({ code: '123456', providerRequestId: 'p-1' })
            challengeRepositoryMock.markIssued.mockRejectedValue(new Error('db'))
        },
        call: startReg,
        throws: true,
        after: () => {
            expect(challengeRepositoryMock.markInvalidated).toHaveBeenCalledWith('ch-new')
        },
    },
    {
        name: 'startPhoneRegistration · the challenge was invalidated meanwhile',
        arrange: () => {
            challengeRepositoryMock.create.mockResolvedValue({ id: 'ch-new' })
            issueMock.mockResolvedValue({ code: '123456', providerRequestId: 'p-1' })
            challengeRepositoryMock.markIssued.mockResolvedValue(undefined)
        },
        call: startReg,
        error: badRequest('Phone registration challenge is no longer valid'),
        after: () => {
            expect(challengeRepositoryMock.markInvalidated).toHaveBeenCalledWith('ch-new')
        },
    },
    {
        name: 'startPhoneRegistration · a taken phone gets the same answer as a free one',
        arrange: () => {
            userRepositoryMock.findByPhone.mockResolvedValue({ id: 9n })
            arrangeIssued()
        },
        call: startReg,
        after: () => {
            expect(challengeRepositoryMock.create).toHaveBeenCalledWith(
                expect.objectContaining({ flow: 'register_phone', phone: '+380501234567' }),
            )
            expect(loggerMock.info).toHaveBeenCalledWith(
                expect.objectContaining({ event: 'phone_auth_collision_detected' }),
                'Phone registration collision detected',
            )
        },
    },
    {
        name: 'startPhoneRegistration · a free phone',
        arrange: arrangeIssued,
        call: startReg,
        after: () => {
            expect(challengeRepositoryMock.invalidatePendingForPhoneFlow).toHaveBeenCalledWith(
                '+380501234567',
                'register_phone',
            )
            expect(challengeRepositoryMock.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    metadata: expect.objectContaining({ sessionId: 's', ipAddress: '203.0.113.9' }),
                }),
            )
            expect(loggerMock.info).not.toHaveBeenCalled()
        },
    },
    // --- phone link, step 1: issue a code (after the checks above) ---------------------------
    {
        name: 'startPhoneLink · the provider fails, the challenge is invalidated',
        arrange: () => {
            arrangeLinkStart()
            issueMock.mockRejectedValue(new Error('sms down'))
        },
        call: startLink,
        throws: true,
        after: () => {
            expect(challengeRepositoryMock.markInvalidated).toHaveBeenCalledWith('ch-new')
        },
    },
    {
        name: 'startPhoneLink · the challenge was invalidated meanwhile',
        arrange: () => {
            arrangeLinkStart()
            issueMock.mockResolvedValue({ code: '123456', providerRequestId: 'p-1' })
            challengeRepositoryMock.markIssued.mockResolvedValue(undefined)
        },
        call: startLink,
        error: badRequest('Phone linking challenge is no longer valid'),
        after: () => {
            expect(challengeRepositoryMock.markInvalidated).toHaveBeenCalledWith('ch-new')
        },
    },
    {
        name: 'startPhoneLink · issued, and the challenge is bound to user and session',
        arrange: () => {
            arrangeLinkStart()
            issueMock.mockResolvedValue({ code: '123456', providerRequestId: 'p-1' })
            challengeRepositoryMock.markIssued.mockResolvedValue(issued())
        },
        call: startLink,
        after: () => {
            expect(challengeRepositoryMock.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    flow: 'link_phone',
                    metadata: expect.objectContaining({ userId: '7', sessionId: 'sess-1' }),
                }),
            )
        },
    },
    // --- phone registration, step 2: confirm the code ---------------------------------------
    {
        name: 'confirmPhoneRegistration · unknown challenge',
        arrange: () => challengeRepositoryMock.findById.mockResolvedValue(undefined),
        call: confirmReg(),
        error: err(404, 'not_found', 'Phone registration challenge not found'),
    },
    {
        name: 'confirmPhoneRegistration · challenge of another flow',
        arrange: () =>
            challengeRepositoryMock.findById.mockResolvedValue(challenge({ flow: 'reset_phone' })),
        call: confirmReg(),
        error: err(404, 'not_found', 'Phone registration challenge not found'),
    },
    {
        name: 'confirmPhoneRegistration · expired',
        arrange: () =>
            challengeRepositoryMock.findById.mockResolvedValue(challenge({ expiresAt: PAST })),
        call: confirmReg(),
        error: badRequest('Phone registration challenge is no longer valid'),
    },
    {
        name: 'confirmPhoneRegistration · already confirmed',
        arrange: () =>
            challengeRepositoryMock.findById.mockResolvedValue(
                challenge({ confirmedAt: new Date() }),
            ),
        call: confirmReg(),
        error: badRequest('Phone registration challenge is no longer valid'),
    },
    {
        name: 'confirmPhoneRegistration · invalidated',
        arrange: () =>
            challengeRepositoryMock.findById.mockResolvedValue(
                challenge({ invalidatedAt: new Date() }),
            ),
        call: confirmReg(),
        error: badRequest('Phone registration challenge is no longer valid'),
    },
    {
        name: 'confirmPhoneRegistration · wrong code counts an attempt',
        arrange: () => {
            challengeRepositoryMock.findById.mockResolvedValue(challenge())
        },
        call: confirmReg('000000'),
        error: badRequest('Invalid verification code'),
        after: () => {
            expect(challengeRepositoryMock.consumeAttempt).toHaveBeenCalledWith(
                'ch-1',
                3,
                undefined,
            )
            expect(challengeRepositoryMock.markInvalidatedIfPending).not.toHaveBeenCalled()
            expect(challengeRepositoryMock.markConfirmed).not.toHaveBeenCalled()
        },
    },
    {
        name: 'confirmPhoneRegistration · the last wrong attempt invalidates the challenge',
        arrange: () => {
            challengeRepositoryMock.findById.mockResolvedValue(challenge({ attemptCount: 2 }))
        },
        call: confirmReg('000000'),
        error: badRequest('Invalid verification code'),
        after: () => {
            expect(challengeRepositoryMock.markInvalidatedIfPending).toHaveBeenCalledWith(
                'ch-1',
                undefined,
            )
        },
    },
    {
        name: 'confirmPhoneRegistration · lost the race to confirm',
        arrange: () => {
            challengeRepositoryMock.findById.mockResolvedValue(challenge())
            challengeRepositoryMock.markConfirmed.mockResolvedValue(undefined)
        },
        call: confirmReg(),
        error: badRequest('Phone registration challenge is no longer valid'),
    },
    {
        name: 'confirmPhoneRegistration · storage fails',
        arrange: () => {
            challengeRepositoryMock.findById.mockResolvedValue(challenge())
            challengeRepositoryMock.markConfirmed.mockRejectedValue(new Error('db'))
        },
        call: confirmReg(),
        throws: true,
    },
    {
        name: 'confirmPhoneRegistration · right code',
        arrange: () => {
            challengeRepositoryMock.findById.mockResolvedValue(challenge())
            challengeRepositoryMock.markConfirmed.mockResolvedValue(challenge())
        },
        call: confirmReg(),
        after: () => {
            // feat-103: the right code spends a try too.
            expect(challengeRepositoryMock.consumeAttempt).toHaveBeenCalledWith(
                'ch-1',
                3,
                undefined,
            )
        },
    },
    // --- phone registration, step 3: complete -----------------------------------------------
    {
        name: 'completePhoneRegistration · unknown challenge',
        arrange: () => challengeRepositoryMock.findById.mockResolvedValue(undefined),
        call: completeReg,
        error: err(404, 'not_found', 'Phone registration challenge not found'),
    },
    {
        name: 'completePhoneRegistration · not confirmed yet',
        arrange: () => challengeRepositoryMock.findById.mockResolvedValue(challenge()),
        call: completeReg,
        error: badRequest(
            'Phone registration challenge must be confirmed before completing registration',
        ),
    },
    {
        name: 'completePhoneRegistration · confirmed from another session',
        arrange: () =>
            challengeRepositoryMock.findById.mockResolvedValue(
                challenge({ confirmedAt: new Date(), metadata: { sessionId: 'other' } }),
            ),
        call: completeReg,
        error: badRequest('Phone registration challenge must be completed from the same session'),
    },
    {
        name: 'completePhoneRegistration · the phone has been taken meanwhile',
        arrange: () => {
            challengeRepositoryMock.findById.mockResolvedValue(
                challenge({ confirmedAt: new Date() }),
            )
            userRepositoryMock.findByPhone.mockResolvedValue({ id: 9n })
        },
        call: completeReg,
        error: err(409, 'conflict', 'Phone already exist'),
        after: () => {
            expect(userRepositoryMock.create).not.toHaveBeenCalled()
        },
    },
    {
        name: 'completePhoneRegistration · hashing fails',
        arrange: () => {
            challengeRepositoryMock.findById.mockResolvedValue(
                challenge({ confirmedAt: new Date() }),
            )
            userRepositoryMock.findByPhone.mockResolvedValue(undefined)
            hashPasswordMock.mockRejectedValue(new Error('scrypt'))
        },
        call: completeReg,
        throws: true,
    },
    // --- phone link, step 1 -----------------------------------------------------------------
    {
        name: 'startPhoneLink · no session',
        call: (s) =>
            s.startPhoneLink(
                7n,
                { phone: '+380501234567', currentPassword: 'x' },
                {
                    ...IP,
                    sessionId: null,
                    presentedSessionToken: TOKEN,
                    sessionStored: sessionStillStored,
                },
            ),
        error: badRequest('Phone linking requires an active session'),
    },
    {
        name: 'startPhoneLink · unknown user',
        arrange: () => userRepositoryMock.findById.mockResolvedValue(undefined),
        call: startLink,
        error: err(404, 'not_found', 'User not found'),
    },
    ...(
        [
            ['no presented token', undefined],
            ['a presented token that is no longer current', 'stale-token'],
        ] as const
    ).map(([state, presented]): Row => ({
        name: `startPhoneLink · ${state}`,
        arrange: arrangeLinkStart,
        call: startLinkAs(presented),
        error: SESSION_REVOKED,
        after: () => {
            expect(validatePasswordMock).not.toHaveBeenCalled()
            expect(consumeAuthThrottleMock).not.toHaveBeenCalled()
            expect(challengeRepositoryMock.create).not.toHaveBeenCalled()
            expect(issueMock).not.toHaveBeenCalled()
        },
    })),
    {
        name: 'startPhoneLink · account without a password',
        arrange: () => userRepositoryMock.findById.mockResolvedValue(account({ password: null })),
        call: startLink,
        error: badRequest('Set a password before managing recovery methods'),
    },
    {
        name: 'startPhoneLink · wrong current password',
        arrange: () => {
            userRepositoryMock.findById.mockResolvedValue(account())
            validatePasswordMock.mockResolvedValue(false)
        },
        call: startLink,
        error: badRequest('Current password is incorrect'),
        after: () => {
            // feat-109: only the per-user password budget is spent, never the link counters.
            expect(consumeAuthThrottleMock.mock.calls.map((call) => call[0].scope)).toEqual([
                'change_password_user',
            ])
            expect(resetAuthThrottleMock).not.toHaveBeenCalled()
        },
    },
    {
        name: 'startPhoneLink · the account has a phone already',
        arrange: () => {
            userRepositoryMock.findById.mockResolvedValue(account({ phone: '+380509999999' }))
            validatePasswordMock.mockResolvedValue(true)
        },
        call: startLink,
        error: badRequest('Phone is already linked to this account'),
    },
    {
        name: 'startPhoneLink · invalid phone',
        arrange: () => {
            userRepositoryMock.findById.mockResolvedValue(account())
            validatePasswordMock.mockResolvedValue(true)
        },
        call: (s) =>
            s.startPhoneLink(
                7n,
                { phone: 'nope', currentPassword: 'x' },
                {
                    ...IP,
                    sessionId: 'sess-1',
                    presentedSessionToken: TOKEN,
                    sessionStored: sessionStillStored,
                },
            ),
        error: badRequest('Phone number must be valid and in a supported format'),
    },
    {
        name: 'startPhoneLink · the phone belongs to another account',
        arrange: () => {
            userRepositoryMock.findById.mockResolvedValue(account())
            validatePasswordMock.mockResolvedValue(true)
            userRepositoryMock.phoneExistsForOtherUser.mockResolvedValue(true)
        },
        call: startLink,
        error: err(409, 'conflict', 'Phone is already linked to another account'),
    },
    {
        name: 'startPhoneLink · a code was sent a moment ago',
        arrange: () => {
            userRepositoryMock.findById.mockResolvedValue(account())
            validatePasswordMock.mockResolvedValue(true)
            userRepositoryMock.phoneExistsForOtherUser.mockResolvedValue(false)
            challengeRepositoryMock.findLatestPendingForPhoneFlow.mockResolvedValue({
                resendAvailableAt: new Date(Date.now() + 30_000),
            })
        },
        call: startLink,
        error: err(
            429,
            'rate_limited',
            'A verification code was already sent recently. Please wait before requesting another one.',
            'resend_cooldown_active',
        ),
    },
    // --- phone link, step 2 -----------------------------------------------------------------
    {
        name: 'confirmPhoneLink · unknown challenge',
        arrange: () => challengeRepositoryMock.findById.mockResolvedValue(undefined),
        call: confirmLink(),
        error: err(404, 'not_found', 'Phone linking challenge not found'),
    },
    {
        name: 'confirmPhoneLink · challenge of another user',
        arrange: () =>
            challengeRepositoryMock.findById.mockResolvedValue(
                linkChallenge({ metadata: { sessionId: 'sess-1', userId: '8' } }),
            ),
        call: confirmLink(),
        error: err(401, 'unauthorized', 'Challenge does not belong to this account'),
    },
    {
        name: 'confirmPhoneLink · another session',
        arrange: () => challengeRepositoryMock.findById.mockResolvedValue(linkChallenge()),
        call: confirmLink('123456', 'other-session'),
        error: badRequest('Phone linking challenge must be confirmed from the same session'),
    },
    {
        name: 'confirmPhoneLink · expired',
        arrange: () =>
            challengeRepositoryMock.findById.mockResolvedValue(linkChallenge({ expiresAt: PAST })),
        call: confirmLink(),
        error: badRequest('Phone linking challenge is no longer valid'),
    },
    {
        name: 'confirmPhoneLink · wrong code counts an attempt',
        arrange: () => {
            challengeRepositoryMock.findById.mockResolvedValue(linkChallenge())
        },
        call: confirmLink('000000'),
        error: badRequest('Invalid verification code'),
        after: () => {
            expect(challengeRepositoryMock.consumeAttempt).toHaveBeenCalled()
        },
    },
    {
        name: 'confirmPhoneLink · the account got a phone meanwhile',
        arrange: () => {
            challengeRepositoryMock.findById.mockResolvedValue(linkChallenge())
            userRepositoryMock.findById.mockResolvedValue(account({ phone: '+380509999999' }))
        },
        call: confirmLink(),
        error: badRequest('Phone is already linked to this account'),
    },
    {
        name: 'confirmPhoneLink · the phone got taken meanwhile',
        arrange: () => {
            challengeRepositoryMock.findById.mockResolvedValue(linkChallenge())
            userRepositoryMock.findById.mockResolvedValue(account())
            userRepositoryMock.phoneExistsForOtherUser.mockResolvedValue(true)
        },
        call: confirmLink(),
        error: err(409, 'conflict', 'Phone is already linked to another account'),
    },
    {
        name: 'confirmPhoneLink · lost the race to confirm',
        arrange: () => {
            challengeRepositoryMock.findById.mockResolvedValue(linkChallenge())
            userRepositoryMock.findById.mockResolvedValue(account())
            userRepositoryMock.phoneExistsForOtherUser.mockResolvedValue(false)
            challengeRepositoryMock.markConfirmed.mockResolvedValue(undefined)
        },
        call: confirmLink(),
        error: badRequest('Phone linking challenge is no longer valid'),
        after: () => {
            expect(userRepositoryMock.update).not.toHaveBeenCalled()
            expect(userRepositoryMock.updateIfSessionToken).not.toHaveBeenCalled()
        },
    },
    ...(
        [
            ['no presented token', undefined],
            ['a presented token that is no longer current', 'stale-token'],
        ] as const
    ).map(([state, presented]): Row => ({
        name: `confirmPhoneLink · ${state}`,
        arrange: () => {
            challengeRepositoryMock.findById.mockResolvedValue(linkChallenge())
            userRepositoryMock.findById.mockResolvedValue(account())
            userRepositoryMock.phoneExistsForOtherUser.mockResolvedValue(false)
            challengeRepositoryMock.markConfirmed.mockResolvedValue(linkChallenge())
        },
        call: confirmLinkAs(presented),
        error: SESSION_REVOKED,
        after: () => {
            expect(challengeRepositoryMock.markConfirmed).not.toHaveBeenCalled()
            expect(userRepositoryMock.updateIfSessionToken).not.toHaveBeenCalled()
            expect(userRepositoryMock.update).not.toHaveBeenCalled()
        },
    })),
    {
        name: 'confirmPhoneLink · the session was revoked before the conditional write',
        arrange: () => {
            challengeRepositoryMock.findById.mockResolvedValue(linkChallenge())
            userRepositoryMock.findById.mockResolvedValue(account())
            userRepositoryMock.phoneExistsForOtherUser.mockResolvedValue(false)
            challengeRepositoryMock.markConfirmed.mockResolvedValue(linkChallenge())
            userRepositoryMock.updateIfSessionToken.mockResolvedValue(undefined)
        },
        call: confirmLink(),
        error: SESSION_REVOKED,
        after: () => {
            expect(userRepositoryMock.updateIfSessionToken).toHaveBeenCalledWith(7n, TOKEN, {
                phone: '+380501234567',
            })
            expect(userRepositoryMock.update).not.toHaveBeenCalled()
        },
    },
    {
        name: 'confirmPhoneLink · linked',
        arrange: () => {
            challengeRepositoryMock.findById.mockResolvedValue(linkChallenge())
            userRepositoryMock.findById.mockResolvedValue(account())
            userRepositoryMock.phoneExistsForOtherUser.mockResolvedValue(false)
            challengeRepositoryMock.markConfirmed.mockResolvedValue(linkChallenge())
            userRepositoryMock.updateIfSessionToken.mockResolvedValue(
                account({ phone: '+380501234567' }),
            )
        },
        call: confirmLink(),
        after: () => {
            expect(userRepositoryMock.updateIfSessionToken).toHaveBeenCalledWith(7n, TOKEN, {
                phone: '+380501234567',
            })
            expect(userRepositoryMock.update).not.toHaveBeenCalled()
        },
    },
    // --- e-mail link ------------------------------------------------------------------------
    ...(
        [
            ['no presented token', undefined],
            ['a presented token that is no longer current', 'stale-token'],
        ] as const
    ).map(([state, presented]): Row => ({
        name: `startEmailLink · ${state}`,
        arrange: () => {
            userRepositoryMock.findById.mockResolvedValue(account())
            validatePasswordMock.mockResolvedValue(true)
            userRepositoryMock.emailExistsForOtherUser.mockResolvedValue(false)
        },
        call: startEmailAs(presented),
        error: SESSION_REVOKED,
        after: () => {
            expect(validatePasswordMock).not.toHaveBeenCalled()
            expect(consumeAuthThrottleMock).not.toHaveBeenCalled()
            expect(userRepositoryMock.emailExistsForOtherUser).not.toHaveBeenCalled()
        },
    })),
    {
        name: 'startEmailLink · wrong current password',
        arrange: () => {
            userRepositoryMock.findById.mockResolvedValue(account())
            validatePasswordMock.mockResolvedValue(false)
        },
        call: startEmail,
        error: badRequest('Current password is incorrect'),
    },
    {
        name: 'startEmailLink · the account has an e-mail already',
        arrange: () => {
            userRepositoryMock.findById.mockResolvedValue(account({ email: 'a@example.com' }))
            validatePasswordMock.mockResolvedValue(true)
        },
        call: startEmail,
        error: badRequest('Email is already linked to this account'),
        after: () => {
            // feat-109: the password budget is spent and, the password being right, reset.
            expect(consumeAuthThrottleMock.mock.calls.map((call) => call[0].scope)).toEqual([
                'change_password_user',
            ])
            expect(resetAuthThrottleMock).toHaveBeenCalledTimes(1)
        },
    },
    {
        name: 'startEmailLink · the address belongs to another account',
        arrange: () => {
            userRepositoryMock.findById.mockResolvedValue(account())
            validatePasswordMock.mockResolvedValue(true)
            userRepositoryMock.emailExistsForOtherUser.mockResolvedValue(true)
        },
        call: startEmail,
        error: err(409, 'conflict', 'Email is already linked to another account'),
    },
    // --- logout / renew / logout all --------------------------------------------------------
    {
        name: 'logout · the session library refuses',
        arrange: () => authMock.logout.mockResolvedValue(false),
        call: (s) => s.logout(authMock as never, sessionMock as never),
        error: internalError('Failed to log out user'),
    },
    {
        name: 'logout · the session library throws',
        arrange: () => authMock.logout.mockRejectedValue(new Error('redis')),
        call: (s) => s.logout(authMock as never, sessionMock as never),
        throws: true,
    },
    {
        name: 'logout · no rotated CSRF token',
        arrange: () => {
            authMock.logout.mockResolvedValue(true)
            sessionMock.sessionInfo = { id: 'session-id', data: {} }
        },
        call: (s) => s.logout(authMock as never, sessionMock as never),
        error: internalError('Missing rotated CSRF token'),
    },
    {
        name: 'logout · ok hands out the rotated CSRF token',
        arrange: () => authMock.logout.mockResolvedValue(true),
        call: (s) => s.logout(authMock as never, sessionMock as never),
    },
    {
        name: 'renewSession · nobody is signed in',
        arrange: () => authMock.getUserId.mockReturnValue(null),
        call: (s) => s.renewSession(authMock as never, sessionMock as never),
        error: internalError('No signed-in session to renew'),
    },
    {
        name: 'renewSession · no user token in the session and none given',
        arrange: () => authMock.getUserId.mockReturnValue('7'),
        call: (s) => s.renewSession(authMock as never, sessionMock as never),
        error: internalError('No signed-in session to renew'),
    },
    {
        name: 'renewSession · logs in under the rotated token it was given',
        arrange: () => {
            authMock.getUserId.mockReturnValue('7')
            authMock.login.mockResolvedValue(true)
            generateWsTokenMock.mockResolvedValue('ws-token')
        },
        call: (s) => s.renewSession(authMock as never, sessionMock as never, 'rotated'),
        after: () => {
            expect(authMock.login).toHaveBeenCalledWith('7', 'rotated')
        },
    },
    {
        name: 'logoutAll · the user is gone',
        arrange: () => {
            authMock.getUserId.mockReturnValue('7')
            userRepositoryMock.updateIfSessionToken.mockResolvedValue(undefined)
            userRepositoryMock.findSessionToken.mockResolvedValue(undefined)
        },
        call: (s) => s.logoutAll(authMock as never, sessionMock as never),
        error: err(404, 'not_found', 'User not found'),
        after: () => {
            expect(authMock.logoutAll).not.toHaveBeenCalled()
        },
    },
    {
        name: 'logoutAll · no presented token',
        arrange: () => {
            authMock.getUserId.mockReturnValue('7')
            authMock.getPresentedUserToken.mockReturnValue(undefined)
            userRepositoryMock.findSessionToken.mockResolvedValue('current-token')
        },
        call: (s) => s.logoutAll(authMock as never, sessionMock as never),
        error: SESSION_REVOKED,
        after: () => {
            expect(userRepositoryMock.updateIfSessionToken).not.toHaveBeenCalled()
            expect(userRepositoryMock.update).not.toHaveBeenCalled()
            expect(authMock.logoutAll).not.toHaveBeenCalled()
            expect(securityNotice).not.toHaveBeenCalled()
        },
    },
    {
        name: 'logoutAll · the session was revoked before the conditional rotation',
        arrange: () => {
            authMock.getUserId.mockReturnValue('7')
            userRepositoryMock.updateIfSessionToken.mockResolvedValue(undefined)
            userRepositoryMock.findSessionToken.mockResolvedValue('rotated-by-a-claim')
        },
        call: (s) => s.logoutAll(authMock as never, sessionMock as never),
        error: SESSION_REVOKED,
        after: () => {
            expect(userRepositoryMock.updateIfSessionToken).toHaveBeenCalledWith(
                7n,
                TOKEN,
                { sessionToken: 'rotated-token' },
                expect.anything(),
            )
            expect(authMock.logoutAll).not.toHaveBeenCalled()
            expect(securityNotice).not.toHaveBeenCalled()
        },
    },
    {
        name: 'logoutAll · the rotation fails, so nothing else is done',
        arrange: () => {
            authMock.getUserId.mockReturnValue('7')
            userRepositoryMock.updateIfSessionToken.mockRejectedValue(new Error('db'))
        },
        call: (s) => s.logoutAll(authMock as never, sessionMock as never),
        throws: true,
        after: () => {
            expect(authMock.logoutAll).not.toHaveBeenCalled()
        },
    },
    {
        // feat-101: after the rotation the cleanup is memory; its failure is logged only.
        name: 'logoutAll · deleting the records throws after the rotation: still success',
        arrange: () => {
            authMock.getUserId.mockReturnValue('7')
            userRepositoryMock.updateIfSessionToken.mockResolvedValue(account())
            authMock.logoutAll.mockRejectedValue(new Error('bug'))
        },
        call: (s) => s.logoutAll(authMock as never, sessionMock as never),
        after: () => {
            expect(userRepositoryMock.updateIfSessionToken).toHaveBeenCalledWith(
                7n,
                TOKEN,
                { sessionToken: 'rotated-token' },
                expect.anything(),
            )
            expect(securityNotice).toHaveBeenCalledWith(7n, 'logout_all')
        },
    },
    {
        name: 'logoutAll · the cleanup stops after the rotation: still success',
        arrange: () => {
            authMock.getUserId.mockReturnValue('7')
            userRepositoryMock.updateIfSessionToken.mockResolvedValue(account())
            authMock.logoutAll.mockResolvedValue({ deleted: 1, complete: false })
        },
        call: (s) => s.logoutAll(authMock as never, sessionMock as never),
        after: () => {
            expect(securityNotice).toHaveBeenCalledWith(7n, 'logout_all')
        },
    },
    {
        name: 'logoutAll · ok rotates, deletes, notifies',
        arrange: () => {
            authMock.getUserId.mockReturnValue('7')
            userRepositoryMock.updateIfSessionToken.mockResolvedValue(account())
            authMock.logoutAll.mockResolvedValue({ deleted: 3, complete: true })
        },
        call: (s) => s.logoutAll(authMock as never, sessionMock as never),
        after: () => {
            expect(securityNotice).toHaveBeenCalledWith(7n, 'logout_all')
        },
    },
    // --- change password --------------------------------------------------------------------
    {
        name: 'changePassword · unknown user',
        arrange: () => userRepositoryMock.findById.mockResolvedValue(undefined),
        call: change({ currentPassword: 'old', newPassword: 'new-password' }),
        error: err(404, 'not_found', 'User not found'),
    },
    ...(
        [
            ['no presented token', undefined],
            ['a presented token that is no longer current', 'stale-token'],
        ] as const
    ).map(([state, presented]): Row => ({
        name: `changePassword · ${state}`,
        arrange: () => {
            userRepositoryMock.findById.mockResolvedValue(account())
            validatePasswordMock.mockResolvedValue(true)
            hashPasswordMock.mockResolvedValue('new-hash')
            userRepositoryMock.changePasswordIfCurrent.mockResolvedValue(account())
        },
        call: changeAs(presented, { currentPassword: 'old', newPassword: 'new-password' }),
        error: SESSION_REVOKED,
        after: () => {
            expect(validatePasswordMock).not.toHaveBeenCalled()
            expect(userRepositoryMock.changePasswordIfCurrent).not.toHaveBeenCalled()
            expect(destroyAllSessionsMock).not.toHaveBeenCalled()
            expect(securityNotice).not.toHaveBeenCalled()
        },
    })),
    {
        name: 'changePassword · the current password is missing',
        arrange: () => userRepositoryMock.findById.mockResolvedValue(account()),
        call: change({ newPassword: 'new-password' }),
        error: badRequest('Current password is required'),
    },
    {
        name: 'changePassword · the current password is wrong',
        arrange: () => {
            userRepositoryMock.findById.mockResolvedValue(account())
            validatePasswordMock.mockResolvedValue(false)
        },
        call: change({ currentPassword: 'old', newPassword: 'new-password' }),
        error: badRequest('Current password is incorrect'),
        after: () => {
            expect(userRepositoryMock.changePasswordIfCurrent).not.toHaveBeenCalled()
        },
    },
    {
        name: 'changePassword · somebody else changed it first',
        arrange: () => {
            // The re-read after the lost write finds the other change's password.
            userRepositoryMock.findById
                .mockResolvedValueOnce(account())
                .mockResolvedValueOnce(account({ password: 'other-hash', sessionToken: 'other' }))
            validatePasswordMock.mockResolvedValue(true)
            hashPasswordMock.mockResolvedValue('new-hash')
            userRepositoryMock.changePasswordIfCurrent.mockResolvedValue(undefined)
        },
        call: change({ currentPassword: 'old', newPassword: 'new-password' }),
        error: err(409, 'conflict', 'Password was changed by another request. Please try again.'),
        after: () => {
            expect(destroyAllSessionsMock).not.toHaveBeenCalled()
            expect(resetAuthThrottleMock).not.toHaveBeenCalled()
        },
    },
    {
        name: 'changePassword · the session was revoked before the conditional write',
        arrange: () => {
            // The re-read: the same password, the token rotated by a claim or logout-all.
            userRepositoryMock.findById
                .mockResolvedValueOnce(account())
                .mockResolvedValueOnce(account({ sessionToken: 'rotated-elsewhere' }))
            validatePasswordMock.mockResolvedValue(true)
            hashPasswordMock.mockResolvedValue('new-hash')
            userRepositoryMock.changePasswordIfCurrent.mockResolvedValue(undefined)
        },
        call: change({ currentPassword: 'old', newPassword: 'new-password' }),
        error: SESSION_REVOKED,
        after: () => {
            expect(userRepositoryMock.changePasswordIfCurrent).toHaveBeenCalledWith(
                7n,
                'stored-hash',
                TOKEN,
                { password: 'new-hash', sessionToken: 'rotated-token' },
                expect.anything(),
            )
            expect(destroyAllSessionsMock).not.toHaveBeenCalled()
            expect(resetAuthThrottleMock).not.toHaveBeenCalled()
            expect(securityNotice).not.toHaveBeenCalled()
        },
    },
    {
        name: 'changePassword · the user is gone by the re-read after a lost write',
        arrange: () => {
            userRepositoryMock.findById
                .mockResolvedValueOnce(account())
                .mockResolvedValueOnce(undefined)
            validatePasswordMock.mockResolvedValue(true)
            hashPasswordMock.mockResolvedValue('new-hash')
            userRepositoryMock.changePasswordIfCurrent.mockResolvedValue(undefined)
        },
        call: change({ currentPassword: 'old', newPassword: 'new-password' }),
        error: err(404, 'not_found', 'User not found'),
        after: () => {
            expect(destroyAllSessionsMock).not.toHaveBeenCalled()
        },
    },
    {
        name: 'changePassword · an account without a password may set one',
        arrange: () => {
            userRepositoryMock.findById.mockResolvedValue(account({ password: null }))
            hashPasswordMock.mockResolvedValue('new-hash')
            userRepositoryMock.changePasswordIfCurrent.mockResolvedValue(account())
            destroyAllSessionsMock.mockResolvedValue({ deleted: 0, complete: true })
        },
        call: change({ newPassword: 'new-password' }),
        after: () => {
            expect(validatePasswordMock).not.toHaveBeenCalled()
            expect(userRepositoryMock.changePasswordIfCurrent).toHaveBeenCalledWith(
                7n,
                null,
                TOKEN,
                { password: 'new-hash', sessionToken: 'rotated-token' },
                expect.anything(),
            )
        },
    },
    {
        name: 'changePassword · cleanup of the old sessions fails, the change still stands',
        arrange: () => {
            userRepositoryMock.findById.mockResolvedValue(account())
            validatePasswordMock.mockResolvedValue(true)
            hashPasswordMock.mockResolvedValue('new-hash')
            userRepositoryMock.changePasswordIfCurrent.mockResolvedValue(account())
            destroyAllSessionsMock.mockRejectedValue(new Error('redis'))
        },
        call: change({ currentPassword: 'old', newPassword: 'new-password' }),
        after: () => {
            expect(loggerMock.warn).toHaveBeenCalledWith(
                expect.objectContaining({ userId: '7' }),
                'Previous sessions not deleted after a password change',
            )
            expect(securityNotice).toHaveBeenCalledWith(7n, 'password_changed')
        },
    },
    {
        name: 'changePassword · ok rotates the token, resets the budget, drops the old sessions',
        arrange: () => {
            userRepositoryMock.findById.mockResolvedValue(account())
            validatePasswordMock.mockResolvedValue(true)
            hashPasswordMock.mockResolvedValue('new-hash')
            userRepositoryMock.changePasswordIfCurrent.mockResolvedValue(account())
            destroyAllSessionsMock.mockResolvedValue({ deleted: 0, complete: true })
        },
        call: change({ currentPassword: 'old', newPassword: 'new-password' }),
        after: () => {
            expect(destroyAllSessionsMock).toHaveBeenCalledWith('old-token')
            expect(resetAuthThrottleMock).toHaveBeenCalledWith(
                expect.objectContaining({ scope: 'change_password_user' }),
                '7',
            )
            expect(securityNotice).toHaveBeenCalledWith(7n, 'password_changed')
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

describe.each(ROWS)('authService · $name', (row) => {
    it('answers as the table says and leaves the stated side effects', async () => {
        row.arrange?.()
        const { authService } = await import('./auth-service.js')
        // ADR 0004: an infrastructure failure is not an AppError; it propagates to the transport.
        if (row.throws === true) {
            await expect(row.call(authService)).rejects.toBeInstanceOf(Error)
        } else {
            const result = (await row.call(authService)) as Result<unknown, AppError>

            if (row.error === undefined) {
                expect(
                    Result.isOk(result),
                    JSON.stringify(Result.isError(result) && result.error),
                ).toBe(true)
            } else {
                expect(Result.isError(result)).toBe(true)
                if (Result.isError(result)) expect(describeError(result.error)).toEqual(row.error)
            }
        }
        row.after?.()
    })
})

describe('authService · success payloads', () => {
    it('logout hands out the rotated CSRF token', async () => {
        authMock.logout.mockResolvedValue(true)
        const { authService } = await import('./auth-service.js')
        const result = await authService.logout(authMock as never, sessionMock as never)
        expect(Result.isOk(result) && result.value).toEqual({ status: 'success', csrfToken: CSRF })
    })

    it('logoutAll reports how many records were deleted', async () => {
        authMock.getUserId.mockReturnValue('7')
        userRepositoryMock.updateIfSessionToken.mockResolvedValue(account())
        authMock.logoutAll.mockResolvedValue({ deleted: 3, complete: true })
        const { authService } = await import('./auth-service.js')
        const result = await authService.logoutAll(authMock as never, sessionMock as never)
        expect(Result.isOk(result) && result.value).toEqual({
            status: 'success',
            deletedCount: 3,
            csrfToken: CSRF,
        })
    })

    it('renewSession returns the new CSRF token and a WebSocket token', async () => {
        authMock.getUserId.mockReturnValue('7')
        authMock.login.mockResolvedValue(true)
        generateWsTokenMock.mockResolvedValue('ws-token')
        const { authService } = await import('./auth-service.js')
        const result = await authService.renewSession(
            authMock as never,
            sessionMock as never,
            'rotated',
        )
        expect(Result.isOk(result) && result.value).toEqual({
            csrfToken: CSRF,
            wsUrl: 'wss://example.com/ws',
            wsToken: 'ws-token',
        })
    })

    it('changePassword hands back the rotated session token', async () => {
        userRepositoryMock.findById.mockResolvedValue(account())
        validatePasswordMock.mockResolvedValue(true)
        hashPasswordMock.mockResolvedValue('new-hash')
        userRepositoryMock.changePasswordIfCurrent.mockResolvedValue(account())
        destroyAllSessionsMock.mockResolvedValue({ deleted: 0, complete: true })
        const { authService } = await import('./auth-service.js')
        const result = await authService.changePassword(
            7n,
            { currentPassword: 'old', newPassword: 'new-password' },
            TOKEN,
        )
        expect(Result.isOk(result) && result.value).toEqual({
            status: 'success',
            sessionToken: 'rotated-token',
        })
    })

    it('confirmPhoneRegistration returns the challenge it confirmed', async () => {
        challengeRepositoryMock.findById.mockResolvedValue(challenge())
        challengeRepositoryMock.markConfirmed.mockResolvedValue(challenge())
        const { authService } = await import('./auth-service.js')
        const result = await authService.confirmPhoneRegistration(
            { challengeId: 'ch-1', code: '123456' },
            IP,
        )
        expect(Result.isOk(result) && result.value).toEqual({
            status: 'success',
            challengeId: 'ch-1',
            verified: true,
        })
    })

    it('confirmPhoneLink says what it did and returns the serialised user', async () => {
        challengeRepositoryMock.findById.mockResolvedValue(linkChallenge())
        userRepositoryMock.findById.mockResolvedValue(account())
        userRepositoryMock.phoneExistsForOtherUser.mockResolvedValue(false)
        challengeRepositoryMock.markConfirmed.mockResolvedValue(linkChallenge())
        userRepositoryMock.updateIfSessionToken.mockResolvedValue(
            account({ phone: '+380501234567' }),
        )
        const { authService } = await import('./auth-service.js')
        const result = await authService.confirmPhoneLink(
            7n,
            { challengeId: 'ch-1', code: '123456' },
            {
                ...IP,
                sessionId: 'sess-1',
                presentedSessionToken: TOKEN,
                sessionStored: sessionStillStored,
            },
        )
        expect(Result.isOk(result) && result.value).toEqual({
            status: 'success',
            message: 'Phone linked successfully',
            user: { id: '7' },
        })
    })
})
