import { afterEach, describe, expect, it, vi } from 'vitest'

// What the budget does when Redis fails: the reservation fails closed (the caller answers
// 503), the settlement never throws (the answer was already given; the reserve stays).

const redisMock = { eval: vi.fn() }
vi.mock('#database/redis-rate-limit.js', () => ({ default: redisMock }))
const loggerMock = { warn: vi.fn(), error: vi.fn(), info: vi.fn() }
vi.mock('#logger', () => ({ default: loggerMock }))

const { reserveDailyTokens } = await import('./llm-budget-service.js')

const NOW = new Date('2026-03-05T10:00:00.000Z')

afterEach(() => {
    vi.clearAllMocks()
})

describe('reserveDailyTokens without a working Redis', () => {
    it('rejects, so the caller can refuse the message', async () => {
        redisMock.eval.mockRejectedValue(new Error('Command timed out'))

        await expect(
            reserveDailyTokens(7n, { chat: 100 }, { limit: 1_000, now: NOW }),
        ).rejects.toThrow('Command timed out')
    })

    it('does not touch Redis when the budget is switched off', async () => {
        const result = await reserveDailyTokens(7n, { chat: 100 }, { limit: 0, now: NOW })

        expect(result.allowed).toBe(true)
        expect(redisMock.eval).not.toHaveBeenCalled()
    })

    it('refuses nothing it cannot afford to refuse: an empty estimate is allowed at once', async () => {
        redisMock.eval.mockResolvedValue(0)

        const result = await reserveDailyTokens(7n, {}, { limit: 1_000, now: NOW })

        expect(result.allowed).toBe(true)
    })
})

describe('a settlement that cannot reach Redis', () => {
    it('does not throw, logs, and may be tried again', async () => {
        redisMock.eval.mockResolvedValueOnce(100) // the reservation
        const result = await reserveDailyTokens(7n, { chat: 100 }, { limit: 1_000, now: NOW })
        if (!result.allowed) throw new Error('expected allowed')

        redisMock.eval.mockRejectedValueOnce(new Error('Connection is closed.'))
        await expect(result.reservation.settle()).resolves.toBeUndefined()
        expect(loggerMock.warn).toHaveBeenCalled()

        // The refund did not happen, so the next try is allowed to send it.
        redisMock.eval.mockResolvedValueOnce(0)
        await result.reservation.settle()
        expect(redisMock.eval).toHaveBeenCalledTimes(3)
    })
})
