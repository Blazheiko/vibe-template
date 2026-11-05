import { Result } from 'better-result'
import { createHmac } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// feat-074 (H5): the part the three SMS flows share. What each flow does with a confirmed
// challenge is in their own specs and in the G1 tables; here the rollbacks of a start that fails
// half way, the budget of wrong codes, and the answers are pinned on the module itself.

const repo = {
    create: vi.fn(),
    findById: vi.fn(),
    findLatestPendingForPhoneFlow: vi.fn(),
    lockPhoneFlow: vi.fn(() => Promise.resolve()),
    invalidatePendingForPhoneFlow: vi.fn(),
    consumeAttempt: vi.fn(),
    markConfirmed: vi.fn(),
    markInvalidated: vi.fn(),
    markInvalidatedIfPending: vi.fn(),
    markIssued: vi.fn(),
}
const issueMock = vi.fn()

vi.mock('#app/repositories/index.js', () => ({
    smsAuthChallengeRepository: repo,
    withTransaction: <T>(work: (tx: unknown) => Promise<T>): Promise<T> => work({}),
}))
vi.mock('#app/services/auth/sms-verification-provider.js', () => ({
    smsVerificationProvider: { issueVerificationCode: issueMock },
}))

const originalEnv = { ...process.env }
const SECRET = 'a'.repeat(32)
const otp = (code: string): string => createHmac('sha256', SECRET).update(code).digest('hex')
const PHONE = '+380501234567'

beforeEach(() => {
    process.env['APP_KEY'] = SECRET
    process.env['AUTH_SMS_MAX_INVALID_ATTEMPTS'] = '3'
    process.env['AUTH_SMS_CHALLENGE_TTL_SECONDS'] = '600'
    process.env['AUTH_SMS_RESEND_COOLDOWN_SECONDS'] = '60'
})

afterEach(() => {
    vi.resetModules()
    vi.resetAllMocks()
    for (const key of Object.keys(process.env)) {
        if (!(key in originalEnv)) delete process.env[key]
    }
    Object.assign(process.env, originalEnv)
})

const load = () => import('./sms-challenge.js')
const row = (over: Record<string, unknown> = {}) => ({
    id: 'ch-1',
    phone: PHONE,
    flow: 'link_phone',
    codeHash: otp('123456'),
    attemptCount: 0,
    resendAvailableAt: new Date(Date.now() - 1000),
    ...over,
})

describe('findPendingChallenge', () => {
    it('returns the waiting challenge, or undefined when there is none', async () => {
        const { findPendingChallenge } = await load()
        repo.findLatestPendingForPhoneFlow.mockResolvedValue(undefined)
        const none = await findPendingChallenge(PHONE, 'link_phone')
        expect(Result.isOk(none) && none.value).toBeUndefined()

        repo.findLatestPendingForPhoneFlow.mockResolvedValue(row())
        const found = await findPendingChallenge(PHONE, 'link_phone')
        expect(Result.isOk(found) && found.value).toMatchObject({ id: 'ch-1' })
        expect(repo.findLatestPendingForPhoneFlow).toHaveBeenCalledWith(PHONE, 'link_phone')
    })

    it('answers 429 with the wait when the resend time has not come', async () => {
        repo.findLatestPendingForPhoneFlow.mockResolvedValue(
            row({ resendAvailableAt: new Date(Date.now() + 30_000) }),
        )
        const { findPendingChallenge } = await load()
        const result = await findPendingChallenge(PHONE, 'link_phone')
        expect(Result.isError(result) && result.error).toMatchObject({
            _tag: 'RateLimited',
            reason: 'resend_cooldown_active',
            retryAfterSeconds: expect.any(Number),
        })
    })

    // ADR 0004: a storage failure propagates to the transport.
    it('rejects when the lookup fails', async () => {
        const dbError = new Error('db')
        repo.findLatestPendingForPhoneFlow.mockRejectedValue(dbError)
        const { findPendingChallenge } = await load()
        await expect(findPendingChallenge(PHONE, 'link_phone')).rejects.toBe(dbError)
    })
})

describe('openChallenge', () => {
    it('retires the waiting challenges before it stores the new one', async () => {
        repo.invalidatePendingForPhoneFlow.mockResolvedValue(1)
        repo.create.mockResolvedValue(row())
        const { openChallenge } = await load()
        await openChallenge({ phone: PHONE, flow: 'link_phone', metadata: { a: 1 } })
        expect(repo.invalidatePendingForPhoneFlow).toHaveBeenCalledWith(
            PHONE,
            'link_phone',
            expect.anything(),
        )
        expect(repo.invalidatePendingForPhoneFlow.mock.invocationCallOrder[0]).toBeLessThan(
            repo.create.mock.invocationCallOrder[0]!,
        )
    })

    it('stores the flow, the phone, the placeholder hash, the metadata and the times of the configuration', async () => {
        repo.create.mockResolvedValue(row())
        const { openChallenge } = await load()
        const { PENDING_SMS_CODE_HASH_PLACEHOLDER } =
            await import('./sms-auth-challenge-constants.js')
        const before = Date.now()
        await openChallenge({ phone: PHONE, flow: 'link_phone', metadata: { a: 1 } })

        const stored = repo.create.mock.calls[0]![0] as {
            expiresAt: Date
            resendAvailableAt: Date
        }
        expect(stored).toMatchObject({
            flow: 'link_phone',
            phone: PHONE,
            codeHash: PENDING_SMS_CODE_HASH_PLACEHOLDER,
            providerRequestId: null,
            metadata: { a: 1 },
        })
        expect(stored.expiresAt.getTime() - before).toBeGreaterThanOrEqual(599_000)
        expect(stored.resendAvailableAt.getTime() - before).toBeGreaterThanOrEqual(59_000)
        expect(stored.resendAvailableAt.getTime() - before).toBeLessThan(61_000)
    })

    it('takes the code hash it is given (a blind challenge)', async () => {
        repo.create.mockResolvedValue(row())
        const { openChallenge } = await load()
        await openChallenge({
            phone: PHONE,
            flow: 'reset_phone',
            codeHash: 'blind',
            metadata: {},
        })
        expect(repo.create).toHaveBeenCalledWith(
            expect.objectContaining({ codeHash: 'blind' }),
            expect.anything(),
        )
    })

    it('rejects when the row cannot be stored', async () => {
        const dbError = new Error('db')
        repo.create.mockRejectedValue(dbError)
        const { openChallenge } = await load()
        await expect(
            openChallenge({ phone: PHONE, flow: 'link_phone', metadata: {} }),
        ).rejects.toBe(dbError)
    })
})

describe('deliverChallenge and issueSmsChallenge: a start that fails half way leaves no live challenge', () => {
    const options = {
        phone: PHONE,
        flow: 'link_phone' as const,
        metadata: { userId: '7' },
        noLongerValid: 'no longer valid',
    }

    it('sends the code to this phone for this flow, records only its hash, and returns the row', async () => {
        issueMock.mockResolvedValue({ code: '123456', providerRequestId: 'p-1' })
        repo.markIssued.mockResolvedValue(row({ id: 'ch-1' }))
        const { deliverChallenge } = await load()
        const result = await deliverChallenge(row() as never, options)

        expect(Result.isOk(result) && result.value).toMatchObject({ id: 'ch-1' })
        expect(issueMock).toHaveBeenCalledWith({ phone: PHONE, flow: 'link_phone' })
        expect(repo.markIssued).toHaveBeenCalledWith('ch-1', {
            codeHash: otp('123456'),
            providerRequestId: 'p-1',
            metadata: { userId: '7' },
        })
        expect(repo.markInvalidated).not.toHaveBeenCalled()
    })

    it('a provider failure invalidates the challenge, then propagates', async () => {
        const smsError = new Error('sms down')
        issueMock.mockRejectedValue(smsError)
        const { deliverChallenge } = await load()
        await expect(deliverChallenge(row() as never, options)).rejects.toBe(smsError)
        expect(repo.markInvalidated).toHaveBeenCalledWith('ch-1')
        expect(repo.markIssued).not.toHaveBeenCalled()
    })

    it('a failure to record the code invalidates the challenge', async () => {
        issueMock.mockResolvedValue({ code: '123456', providerRequestId: 'p-1' })
        const dbError = new Error('db')
        repo.markIssued.mockRejectedValue(dbError)
        const { deliverChallenge } = await load()
        await expect(deliverChallenge(row() as never, options)).rejects.toBe(dbError)
        expect(repo.markInvalidated).toHaveBeenCalledWith('ch-1')
    })

    it('a challenge invalidated meanwhile is invalidated again and answers 400', async () => {
        issueMock.mockResolvedValue({ code: '123456', providerRequestId: 'p-1' })
        repo.markIssued.mockResolvedValue(undefined)
        const { deliverChallenge } = await load()
        const result = await deliverChallenge(row() as never, options)
        expect(Result.isError(result) && result.error).toEqual({
            _tag: 'BadRequest',
            message: 'no longer valid',
        })
        expect(repo.markInvalidated).toHaveBeenCalledWith('ch-1')
    })

    it('issueSmsChallenge sends nothing when the row cannot be stored', async () => {
        const dbError = new Error('db')
        repo.create.mockRejectedValue(dbError)
        const { issueSmsChallenge } = await load()
        await expect(
            issueSmsChallenge({
                phone: PHONE,
                flow: 'link_phone',
                metadata: {},
                noLongerValid: 'no longer valid',
            }),
        ).rejects.toBe(dbError)
        expect(issueMock).not.toHaveBeenCalled()
    })
})

describe('verifySmsCode', () => {
    const answers = { noLongerValid: 'no longer valid' }

    it('spends a try before it compares, also for the right code', async () => {
        repo.consumeAttempt.mockResolvedValue(row({ attemptCount: 1 }))
        const { verifySmsCode } = await load()
        const result = await verifySmsCode(row() as never, '123456', answers)
        expect(Result.isOk(result)).toBe(true)
        expect(repo.consumeAttempt).toHaveBeenCalledWith('ch-1', 3, undefined)
        expect(repo.markInvalidatedIfPending).not.toHaveBeenCalled()
    })

    it('compares with the code hash of the row the spent try returned', async () => {
        repo.consumeAttempt.mockResolvedValue(row({ attemptCount: 1, codeHash: otp('654321') }))
        const { verifySmsCode } = await load()
        expect(Result.isOk(await verifySmsCode(row() as never, '654321', answers))).toBe(true)
    })

    it('a wrong code keeps the challenge while the budget lasts', async () => {
        repo.consumeAttempt.mockResolvedValue(row({ attemptCount: 1 }))
        const { verifySmsCode } = await load()
        const result = await verifySmsCode(row() as never, '000000', answers)
        expect(Result.isError(result) && result.error).toEqual({
            _tag: 'BadRequest',
            message: 'Invalid verification code',
        })
        expect(repo.markInvalidatedIfPending).not.toHaveBeenCalled()
    })

    it('the wrong code that spends the budget invalidates a pending challenge', async () => {
        repo.consumeAttempt.mockResolvedValue(row({ attemptCount: 3 }))
        const { verifySmsCode } = await load()
        await verifySmsCode(row({ attemptCount: 2 }) as never, '000000', answers)
        expect(repo.markInvalidatedIfPending).toHaveBeenCalledWith('ch-1', undefined)
        expect(repo.markInvalidated).not.toHaveBeenCalled()
    })

    it('the right code on the last try does not invalidate', async () => {
        repo.consumeAttempt.mockResolvedValue(row({ attemptCount: 3 }))
        const { verifySmsCode } = await load()
        expect(Result.isOk(await verifySmsCode(row() as never, '123456', answers))).toBe(true)
        expect(repo.markInvalidatedIfPending).not.toHaveBeenCalled()
    })

    it('answers noLongerValid without comparing when no try can be spent', async () => {
        repo.consumeAttempt.mockResolvedValue(undefined)
        const { verifySmsCode } = await load()
        const result = await verifySmsCode(row() as never, '123456', answers)
        expect(Result.isError(result) && result.error).toEqual({
            _tag: 'BadRequest',
            message: 'no longer valid',
        })
        expect(repo.markInvalidatedIfPending).not.toHaveBeenCalled()
    })

    it('passes the executor to both statements', async () => {
        const tx = {} as never
        repo.consumeAttempt.mockResolvedValue(row({ attemptCount: 3 }))
        const { verifySmsCode } = await load()
        await verifySmsCode(row() as never, '000000', answers, tx)
        expect(repo.consumeAttempt).toHaveBeenCalledWith('ch-1', 3, tx)
        expect(repo.markInvalidatedIfPending).toHaveBeenCalledWith('ch-1', tx)
    })
})

describe('confirmChallenge', () => {
    const answers = { noLongerValid: 'no longer valid' }

    it('is ok when the challenge is marked confirmed', async () => {
        repo.markConfirmed.mockResolvedValue(row())
        const { confirmChallenge } = await load()
        const result = await confirmChallenge(row() as never, answers)
        expect(Result.isOk(result)).toBe(true)
        expect(repo.markConfirmed).toHaveBeenCalledWith('ch-1', undefined)
    })

    it('answers 400 when the challenge stopped being valid meanwhile', async () => {
        repo.markConfirmed.mockResolvedValue(undefined)
        const { confirmChallenge } = await load()
        const result = await confirmChallenge(row() as never, answers)
        expect(Result.isError(result) && result.error).toEqual({
            _tag: 'BadRequest',
            message: 'no longer valid',
        })
    })

    it('rejects when the update fails', async () => {
        const dbError = new Error('db')
        repo.markConfirmed.mockRejectedValue(dbError)
        const { confirmChallenge } = await load()
        await expect(confirmChallenge(row() as never, answers)).rejects.toBe(dbError)
    })
})
