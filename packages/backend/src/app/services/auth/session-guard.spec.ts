import { Result } from 'better-result'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { TX, lockById, withTransaction } = vi.hoisted(() => {
    const TX = { tx: true }
    return {
        TX,
        lockById: vi.fn(),
        withTransaction: vi.fn((work: (tx: unknown) => Promise<unknown>) => work(TX)),
    }
})

vi.mock('#app/repositories/index.js', () => ({
    userRepository: { lockById },
    withTransaction,
}))

const { withCurrentSession } = await import('./session-guard.js')

afterEach(() => {
    vi.clearAllMocks()
})

describe('withCurrentSession', () => {
    it('runs the work under the lock while the presented token is current', async () => {
        const user = { id: 7n, sessionToken: 'current' }
        lockById.mockResolvedValue(user)
        const work = vi.fn().mockResolvedValue(Result.ok('done'))

        const result = await withCurrentSession(7n, 'current', work)

        expect(result).toEqual(Result.ok('done'))
        expect(lockById).toHaveBeenCalledWith(7n, TX)
        expect(work).toHaveBeenCalledWith(TX, user)
    })

    it.each([
        ['a rotated token', { id: 7n, sessionToken: 'rotated' }],
        ['a deleted user', undefined],
    ])('answers session_revoked without the work for %s', async (_name, user) => {
        lockById.mockResolvedValue(user)
        const work = vi.fn()

        const result = await withCurrentSession(7n, 'current', work)

        expect(Result.isError(result) && result.error).toMatchObject({
            reason: 'session_revoked',
        })
        expect(work).not.toHaveBeenCalled()
    })

    it('answers session_revoked without a transaction when no token was presented', async () => {
        const work = vi.fn()

        const result = await withCurrentSession(7n, undefined, work)

        expect(Result.isError(result) && result.error).toMatchObject({
            reason: 'session_revoked',
        })
        expect(withTransaction).not.toHaveBeenCalled()
        expect(work).not.toHaveBeenCalled()
    })
})
