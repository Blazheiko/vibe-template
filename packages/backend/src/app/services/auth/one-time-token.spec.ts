import { Result } from 'better-result'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { badRequest } from '#app/services/shared/errors.js'

// feat-073 (H4): the part the three token flows share. What each flow does with a token is in
// their own specs and, against a real PostgreSQL, in one-time-token-race.pg.test.ts.

const TX = vi.hoisted(() => ({ transaction: true }))
vi.mock('#app/repositories/index.js', () => ({
    withTransaction: <T>(work: (tx: unknown) => Promise<T>): Promise<T> => work(TX),
}))

const repository = {
    create: vi.fn(),
    findByTokenHash: vi.fn(),
    invalidatePendingByUserId: vi.fn(),
    markUsed: vi.fn(),
}

afterEach(() => {
    vi.resetAllMocks()
})

const load = () => import('./one-time-token.js')

describe('hashToken and createToken', () => {
    it('hash with SHA-256 in hex, the same for the same secret', async () => {
        const { hashToken } = await load()
        expect(hashToken('abc')).toBe(
            'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
        )
    })

    it('make 32 random bytes in base64url, a new one each time', async () => {
        const { createToken } = await load()
        const first = createToken()
        expect(first).toMatch(/^[\w-]{43}$/)
        expect(createToken()).not.toBe(first)
    })
})

describe('issueToken', () => {
    const failures = { invalidate: 'cannot retire', create: 'cannot create' }

    it('retires the old tokens first, then stores only the hash of the new one', async () => {
        repository.invalidatePendingByUserId.mockResolvedValue(2)
        repository.create.mockResolvedValue({ id: 1n })
        const { issueToken, hashToken } = await load()

        const result = await issueToken(repository, {
            userId: 7n,
            ttlMs: 60_000,
            failures,
            extra: { targetEmail: 'new@example.com' },
        })

        const secret = Result.isOk(result) ? result.value : ''
        expect(secret).toMatch(/^[\w-]{43}$/)
        expect(repository.invalidatePendingByUserId).toHaveBeenCalledWith(7n)
        const stored = repository.create.mock.calls[0]![0] as {
            userId: bigint
            tokenHash: string
            targetEmail: string
            expiresAt: Date
        }
        expect(stored).toMatchObject({
            userId: 7n,
            targetEmail: 'new@example.com',
            tokenHash: hashToken(secret),
        })
        expect(Object.values(stored).map(String).join(' ')).not.toContain(secret)
        expect(stored.expiresAt.getTime() - Date.now()).toBeGreaterThan(59_000)
        expect(repository.invalidatePendingByUserId.mock.invocationCallOrder[0]).toBeLessThan(
            repository.create.mock.invocationCallOrder[0]!,
        )
    })

    it('stops with its own message when retiring fails, and makes nothing', async () => {
        repository.invalidatePendingByUserId.mockRejectedValue(new Error('db'))
        const { issueToken } = await load()
        const result = await issueToken(repository, { userId: 7n, ttlMs: 1, failures })
        expect(Result.isError(result) && result.error).toMatchObject({
            _tag: 'Internal',
            publicMessage: 'cannot retire',
        })
        expect(repository.create).not.toHaveBeenCalled()
    })

    it('answers with its own message when making the token fails', async () => {
        repository.invalidatePendingByUserId.mockResolvedValue(0)
        repository.create.mockRejectedValue(new Error('db'))
        const { issueToken } = await load()
        const result = await issueToken(repository, { userId: 7n, ttlMs: 1, failures })
        expect(Result.isError(result) && result.error).toMatchObject({
            publicMessage: 'cannot create',
        })
    })
})

describe('findUsableToken', () => {
    const answers = {
        failures: { load: 'cannot load', markExpired: 'cannot burn' },
        used: badRequest('used'),
        expired: badRequest('expired'),
    }
    const row = (over: Record<string, unknown> = {}) => ({
        id: 11n,
        usedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
        ...over,
    })

    it('looks the token up by the hash of the secret', async () => {
        repository.findByTokenHash.mockResolvedValue(row())
        const { findUsableToken, hashToken } = await load()
        const result = await findUsableToken(repository, 'secret', answers)
        expect(Result.isOk(result) && result.value).toMatchObject({ id: 11n })
        expect(repository.findByTokenHash).toHaveBeenCalledWith(hashToken('secret'))
    })

    it('says "no such token" with undefined, not with an error', async () => {
        repository.findByTokenHash.mockResolvedValue(undefined)
        const { findUsableToken } = await load()
        const result = await findUsableToken(repository, 'secret', answers)
        expect(Result.isOk(result) && result.value).toBeUndefined()
    })

    it('answers `used` for a used token and burns nothing', async () => {
        repository.findByTokenHash.mockResolvedValue(row({ usedAt: new Date() }))
        const { findUsableToken } = await load()
        const result = await findUsableToken(repository, 'secret', answers)
        expect(Result.isError(result) && result.error).toEqual(badRequest('used'))
        expect(repository.markUsed).not.toHaveBeenCalled()
    })

    it('burns an expired token and answers `expired`', async () => {
        repository.findByTokenHash.mockResolvedValue(row({ expiresAt: new Date(Date.now() - 1) }))
        repository.markUsed.mockResolvedValue(row())
        const { findUsableToken } = await load()
        const result = await findUsableToken(repository, 'secret', answers)
        expect(Result.isError(result) && result.error).toEqual(badRequest('expired'))
        expect(repository.markUsed).toHaveBeenCalledWith(11n)
    })

    it('fails with its own message when the lookup or the burning fails', async () => {
        const { findUsableToken } = await load()
        repository.findByTokenHash.mockRejectedValue(new Error('db'))
        const lookup = await findUsableToken(repository, 'secret', answers)
        expect(Result.isError(lookup) && lookup.error).toMatchObject({
            publicMessage: 'cannot load',
        })

        repository.findByTokenHash.mockResolvedValue(row({ expiresAt: new Date(Date.now() - 1) }))
        repository.markUsed.mockRejectedValue(new Error('db'))
        const burning = await findUsableToken(repository, 'secret', answers)
        expect(Result.isError(burning) && burning.error).toMatchObject({
            publicMessage: 'cannot burn',
        })
    })
})

describe('consumeTokenAndApply', () => {
    const token = { id: 11n, usedAt: null, expiresAt: new Date(Date.now() + 60_000) }

    it('claims in the transaction, applies in the same one, and returns what apply returned', async () => {
        repository.markUsed.mockResolvedValue(token)
        const apply = vi.fn().mockResolvedValue('done')
        const { consumeTokenAndApply } = await load()
        const result = await consumeTokenAndApply(repository, token, apply, 'cannot apply')
        expect(Result.isOk(result) && result.value).toEqual({ claimed: true, value: 'done' })
        expect(repository.markUsed).toHaveBeenCalledWith(11n, undefined, TX)
        expect(apply).toHaveBeenCalledWith(TX)
    })

    it('does not apply when somebody else claimed the token first', async () => {
        repository.markUsed.mockResolvedValue(undefined)
        const apply = vi.fn()
        const { consumeTokenAndApply } = await load()
        const result = await consumeTokenAndApply(repository, token, apply, 'cannot apply')
        expect(Result.isOk(result) && result.value).toEqual({ claimed: false })
        expect(apply).not.toHaveBeenCalled()
    })

    it('turns a failing apply into the 500 with the cause kept (a unique violation is read from it)', async () => {
        repository.markUsed.mockResolvedValue(token)
        const cause = Object.assign(new Error('duplicate key'), { code: '23505' })
        const { consumeTokenAndApply } = await load()
        const result = await consumeTokenAndApply(
            repository,
            token,
            () => Promise.reject(cause),
            'cannot apply',
        )
        expect(Result.isError(result) && result.error).toEqual({
            _tag: 'Internal',
            publicMessage: 'cannot apply',
            cause,
        })
    })
})
