import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const findSessionToken = vi.hoisted(() => vi.fn())
vi.mock('#app/repositories/index.js', () => ({ userRepository: { findSessionToken } }))

const logger = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }))
vi.mock('#logger', () => ({ default: logger }))

vi.mock('#config/session.js', () => ({ default: { tokenCheckTimeoutMs: 500 } }))

const { checkSessionToken } = await import('./session-token-check.js')

beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
})
afterEach(() => {
    vi.useRealTimers()
})

describe('checkSessionToken (ADR 0002)', () => {
    it('ok when the token is the current one', async () => {
        findSessionToken.mockResolvedValue('current-token')
        await expect(checkSessionToken('7', 'current-token')).resolves.toBe('ok')
        expect(findSessionToken).toHaveBeenCalledWith(7n)
    })

    it('mismatch when the token was rotated', async () => {
        findSessionToken.mockResolvedValue('rotated-token')
        await expect(checkSessionToken('7', 'old-token')).resolves.toBe('mismatch')
    })

    it('mismatch when the user is gone', async () => {
        findSessionToken.mockResolvedValue(undefined)
        await expect(checkSessionToken('7', 'old-token')).resolves.toBe('mismatch')
    })

    it.each(['', '0', '-1', '1.5', 'abc', '01', '9'.repeat(40) + 'x'])(
        'mismatch without a query for the malformed user id %j',
        async (userId) => {
            await expect(checkSessionToken(userId, 'token')).resolves.toBe('mismatch')
            expect(findSessionToken).not.toHaveBeenCalled()
        },
    )

    it('unavailable when the lookup fails', async () => {
        findSessionToken.mockRejectedValue(new Error('connection terminated'))
        await expect(checkSessionToken('7', 'token')).resolves.toBe('unavailable')
        expect(logger.error).toHaveBeenCalledTimes(1)
    })

    // A database that accepts the query and never answers must not hold the request.
    it('unavailable when the lookup does not answer within the deadline', async () => {
        findSessionToken.mockReturnValue(new Promise(() => undefined))

        const result = checkSessionToken('7', 'token')
        await vi.advanceTimersByTimeAsync(499)
        let settled = false
        void result.then(() => {
            settled = true
        })
        await vi.advanceTimersByTimeAsync(0)
        expect(settled).toBe(false)

        await vi.advanceTimersByTimeAsync(1)
        await expect(result).resolves.toBe('unavailable')
        expect(logger.error).toHaveBeenCalledWith(
            expect.objectContaining({ timeoutMs: 500 }),
            'Session token lookup timed out',
        )
    })

    it('does not leave a timer behind after an answer', async () => {
        findSessionToken.mockResolvedValue('token')
        await checkSessionToken('7', 'token')
        expect(vi.getTimerCount()).toBe(0)
    })

    it('a late rejection of the abandoned lookup is not an unhandled rejection', async () => {
        let rejectLate: (err: Error) => void = () => undefined
        findSessionToken.mockReturnValue(
            new Promise((_resolve, reject) => {
                rejectLate = reject
            }),
        )
        const result = checkSessionToken('7', 'token')
        await vi.advanceTimersByTimeAsync(500)
        await expect(result).resolves.toBe('unavailable')

        rejectLate(new Error('connection terminated'))
        await vi.advanceTimersByTimeAsync(0)
        // vitest fails the run on an unhandled rejection; reaching here is the assertion.
        expect(logger.error).toHaveBeenCalledTimes(1)
    })
})
