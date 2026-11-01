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
    invalidatePendingForPhoneFlow: vi.fn(),
    incrementAttemptCount: vi.fn(),
    markConfirmed: vi.fn(),
    markInvalidated: vi.fn(),
    markIssued: vi.fn(),
}
const issueMock = vi.fn()

vi.mock('#app/repositories/index.js', () => ({ smsAuthChallengeRepository: repo }))
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
        const none = await findPendingChallenge(PHONE, 'link_phone', 'cannot load')
        expect(Result.isOk(none) && none.value).toBeUndefined()

        repo.findLatestPendingForPhoneFlow.mockResolvedValue(row())
        const found = await findPendingChallenge(PHONE, 'link_phone', 'cannot load')
        expect(Result.isOk(found) && found.value).toMatchObject({ id: 'ch-1' })
        expect(repo.findLatestPendingForPhoneFlow).toHaveBeenCalledWith(PHONE, 'link_phone')
    })

    it('answers 429 with the wait when the resend time has not come', async () => {
        repo.findLatestPendingForPhoneFlow.mockResolvedValue(
            row({ resendAvailableAt: new Date(Date.now() + 30_000) }),
        )
        const { findPendingChallenge } = await load()
        const result = await findPendingChallenge(PHONE, 'link_phone', 'cannot load')
        expect(Result.isError(result) && result.error).toMatchObject({
            _tag: 'RateLimited',
            reason: 'resend_cooldown_active',
            retryAfterSeconds: expect.any(Number),
        })
    })

    it('fails with its own message when the lookup fails', async () => {
        repo.findLatestPendingForPhoneFlow.mockRejectedValue(new Error('db'))
        const { findPendingChallenge } = await load()
        const result = await findPendingChallenge(PHONE, 'link_phone', 'cannot load')
        expect(Result.isError(result) && result.error).toMatchObject({
            _tag: 'Internal',
            publicMessage: 'cannot load',
        })
    })
})

describe('openChallenge', () => {
    it('retires the waiting challenges before it stores the new one', async () => {
        repo.invalidatePendingForPhoneFlow.mockResolvedValue(1)
        repo.create.mockResolvedValue(row())
        const { openChallenge } = await load()
        await openChallenge({ phone: PHONE, flow: 'link_phone', metadata: { a: 1 }, failure: 'x' })
        expect(repo.invalidatePendingForPhoneFlow).toHaveBeenCalledWith(PHONE, 'link_phone')
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
        await openChallenge({ phone: PHONE, flow: 'link_phone', metadata: { a: 1 }, failure: 'x' })

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
            failure: 'x',
        })
        expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ codeHash: 'blind' }))
    })

    it('fails with its own message when the row cannot be stored', async () => {
        repo.create.mockRejectedValue(new Error('db'))
        const { openChallenge } = await load()
        const result = await openChallenge({
            phone: PHONE,
            flow: 'link_phone',
            metadata: {},
            failure: 'cannot store',
        })
        expect(Result.isError(result) && result.error).toMatchObject({
            publicMessage: 'cannot store',
        })
    })
})

describe('deliverChallenge and issueSmsChallenge: a start that fails half way leaves no live challenge', () => {
    const options = {
        phone: PHONE,
        flow: 'link_phone' as const,
        metadata: { userId: '7' },
        failures: { issue: 'cannot send', markIssued: 'cannot record' },
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

    it('a provider failure invalidates the challenge and answers with its own message', async () => {
        issueMock.mockRejectedValue(new Error('sms down'))
        const { deliverChallenge } = await load()
        const result = await deliverChallenge(row() as never, options)
        expect(Result.isError(result) && result.error).toMatchObject({
            publicMessage: 'cannot send',
        })
        expect(repo.markInvalidated).toHaveBeenCalledWith('ch-1')
        expect(repo.markIssued).not.toHaveBeenCalled()
    })

    it('a failure to record the code invalidates the challenge', async () => {
        issueMock.mockResolvedValue({ code: '123456', providerRequestId: 'p-1' })
        repo.markIssued.mockRejectedValue(new Error('db'))
        const { deliverChallenge } = await load()
        const result = await deliverChallenge(row() as never, options)
        expect(Result.isError(result) && result.error).toMatchObject({
            publicMessage: 'cannot record',
        })
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
        repo.create.mockRejectedValue(new Error('db'))
        const { issueSmsChallenge } = await load()
        const result = await issueSmsChallenge({
            phone: PHONE,
            flow: 'link_phone',
            metadata: {},
            failures: { create: 'cannot store', issue: 'cannot send', markIssued: 'cannot record' },
            noLongerValid: 'no longer valid',
        })
        expect(Result.isError(result) && result.error).toMatchObject({
            publicMessage: 'cannot store',
        })
        expect(issueMock).not.toHaveBeenCalled()
    })
})

describe('verifySmsCode', () => {
    it('accepts the right code and costs nothing', async () => {
        const { verifySmsCode } = await load()
        const result = await verifySmsCode(row() as never, '123456')
        expect(Result.isOk(result)).toBe(true)
        expect(repo.incrementAttemptCount).not.toHaveBeenCalled()
    })

    it('counts a wrong code as a try and keeps the challenge while the budget lasts', async () => {
        repo.incrementAttemptCount.mockResolvedValue({ attemptCount: 1 })
        const { verifySmsCode } = await load()
        const result = await verifySmsCode(row() as never, '000000')
        expect(Result.isError(result) && result.error).toEqual({
            _tag: 'BadRequest',
            message: 'Invalid verification code',
        })
        expect(repo.incrementAttemptCount).toHaveBeenCalledWith('ch-1')
        expect(repo.markInvalidated).not.toHaveBeenCalled()
    })

    it('the try that spends the budget invalidates the challenge', async () => {
        repo.incrementAttemptCount.mockResolvedValue({ attemptCount: 3 })
        const { verifySmsCode } = await load()
        await verifySmsCode(row({ attemptCount: 2 }) as never, '000000')
        expect(repo.markInvalidated).toHaveBeenCalledWith('ch-1')
    })

    it('counts from the row it holds when the counter update returns nothing', async () => {
        repo.incrementAttemptCount.mockResolvedValue(undefined)
        const { verifySmsCode } = await load()
        await verifySmsCode(row({ attemptCount: 2 }) as never, '000000')
        expect(repo.markInvalidated).toHaveBeenCalledWith('ch-1')

        repo.markInvalidated.mockClear()
        await verifySmsCode(row({ attemptCount: 0 }) as never, '000000')
        expect(repo.markInvalidated).not.toHaveBeenCalled()
    })
})

describe('confirmChallenge', () => {
    const answers = { failure: 'cannot confirm', noLongerValid: 'no longer valid' }

    it('is ok when the challenge is marked confirmed', async () => {
        repo.markConfirmed.mockResolvedValue(row())
        const { confirmChallenge } = await load()
        const result = await confirmChallenge(row() as never, answers)
        expect(Result.isOk(result)).toBe(true)
        expect(repo.markConfirmed).toHaveBeenCalledWith('ch-1')
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

    it('fails with its own message when the update fails', async () => {
        repo.markConfirmed.mockRejectedValue(new Error('db'))
        const { confirmChallenge } = await load()
        const result = await confirmChallenge(row() as never, answers)
        expect(Result.isError(result) && result.error).toMatchObject({
            publicMessage: 'cannot confirm',
        })
    })
})
