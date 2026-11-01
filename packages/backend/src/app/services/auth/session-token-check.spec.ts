import { beforeEach, describe, expect, it, vi } from 'vitest'

const findSessionToken = vi.hoisted(() => vi.fn())
vi.mock('#app/repositories/index.js', () => ({ userRepository: { findSessionToken } }))

const logger = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }))
vi.mock('#logger', () => ({ default: logger }))

const { checkSessionToken } = await import('./session-token-check.js')

beforeEach(() => {
    vi.clearAllMocks()
})

// The deadline is not here but in the session-check pool; it is proved against a real
// PostgreSQL in database/session-check-pool.pg.test.ts.
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

    it.each([
        ['a lookup that fails', new Error('connection terminated')],
        [
            'a statement cancelled by statement_timeout',
            Object.assign(new Error('canceling statement due to statement timeout'), {
                code: '57014',
            }),
        ],
        ['a driver query timeout', new Error('Query read timeout')],
    ])('unavailable for %s', async (_name, error) => {
        findSessionToken.mockRejectedValue(error)
        await expect(checkSessionToken('7', 'token')).resolves.toBe('unavailable')
        expect(logger.error).toHaveBeenCalledWith({ err: error }, 'Session token lookup failed')
    })
})
