import { Result } from 'better-result'
import { describe, expect, it, vi } from 'vitest'

// withTransaction as drizzle runs it: commit when the work returns, roll back when it throws.
const outcomes: string[] = []
vi.mock('#app/repositories/index.js', () => ({
    withTransaction: async <T>(work: (tx: unknown) => Promise<T>): Promise<T> => {
        try {
            const value = await work({ tx: true })
            outcomes.push('commit')
            return value
        } catch (err) {
            outcomes.push('rollback')
            throw err
        }
    },
}))

const { withTransactionResult } = await import('./transaction-result.js')
const { badRequest } = await import('./errors.js')

describe('withTransactionResult (feat-106)', () => {
    it('commits and returns an ok result', async () => {
        outcomes.length = 0
        const result = await withTransactionResult(() => Promise.resolve(Result.ok(7)))

        expect(Result.isOk(result) && result.value).toBe(7)
        expect(outcomes).toEqual(['commit'])
    })

    it('rolls back on an error result and returns that error', async () => {
        outcomes.length = 0
        const result = await withTransactionResult(() =>
            Promise.resolve(Result.err(badRequest('refused'))),
        )

        expect(Result.isError(result) && result.error).toEqual(badRequest('refused'))
        expect(outcomes).toEqual(['rollback'])
    })

    it('rolls back and rethrows an exception', async () => {
        outcomes.length = 0
        await expect(
            withTransactionResult(() => Promise.reject(new Error('db down'))),
        ).rejects.toThrow('db down')
        expect(outcomes).toEqual(['rollback'])
    })
})
