import { Result } from 'better-result'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UserRow } from '#app/repositories/index.js'
import { badRequest, conflict } from '#app/services/shared/errors.js'

// feat-073 (H4): the part the three token flows share. What each flow does with a token is in
// their own specs and, against a real PostgreSQL, in one-time-token-race.pg.test.ts.

const { TX, lockById } = vi.hoisted(() => ({
    TX: { transaction: true },
    lockById: vi.fn(),
}))
vi.mock('#app/repositories/index.js', () => ({
    userRepository: { lockById },
    withTransaction: <T>(work: (tx: unknown) => Promise<T>): Promise<T> => work(TX),
}))

const repository = {
    create: vi.fn(),
    findByTokenHash: vi.fn(),
    invalidatePendingByUserId: vi.fn(),
    markUsed: vi.fn(),
    burn: vi.fn(),
}

// The locked row of the token's user, as `userRepository.lockById` returns it.
const lockedUser = (over: Record<string, unknown> = {}) =>
    ({
        id: 7n,
        name: 'Ada',
        email: 'ada@example.com',
        sessionToken: 'session-1',
        ...over,
    }) as unknown as UserRow

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

describe('issueTokenLocked', () => {
    it('locks the user, retires the old tokens, then stores only the hash of the new one, all in the transaction', async () => {
        const user = lockedUser()
        lockById.mockResolvedValue(user)
        repository.invalidatePendingByUserId.mockResolvedValue(2)
        repository.create.mockResolvedValue({ id: 1n })
        const { issueTokenLocked, hashToken } = await load()

        const result = await issueTokenLocked(repository, {
            userId: 7n,
            ttlMs: 60_000,
            extra: { targetEmail: 'new@example.com' },
        })

        expect(Result.isOk(result)).toBe(true)
        const { rawToken: secret, user: returned } = Result.isOk(result)
            ? result.value
            : { rawToken: '', user: undefined }
        expect(secret).toMatch(/^[\w-]{43}$/)
        expect(returned).toBe(user)
        expect(lockById).toHaveBeenCalledWith(7n, TX)
        expect(repository.invalidatePendingByUserId).toHaveBeenCalledWith(7n, TX)
        expect(repository.create).toHaveBeenCalledWith(expect.anything(), TX)
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
        expect(lockById.mock.invocationCallOrder[0]).toBeLessThan(
            repository.invalidatePendingByUserId.mock.invocationCallOrder[0]!,
        )
        expect(repository.invalidatePendingByUserId.mock.invocationCallOrder[0]).toBeLessThan(
            repository.create.mock.invocationCallOrder[0]!,
        )
    })

    it('checks the locked row after the lock and before retiring', async () => {
        const user = lockedUser()
        lockById.mockResolvedValue(user)
        repository.invalidatePendingByUserId.mockResolvedValue(0)
        repository.create.mockResolvedValue({ id: 1n })
        const check = vi.fn().mockReturnValue(Result.ok(undefined))
        const { issueTokenLocked } = await load()

        const result = await issueTokenLocked(repository, { userId: 7n, ttlMs: 1, check })

        expect(Result.isOk(result)).toBe(true)
        expect(check).toHaveBeenCalledWith(user)
        expect(lockById.mock.invocationCallOrder[0]).toBeLessThan(
            check.mock.invocationCallOrder[0]!,
        )
        expect(check.mock.invocationCallOrder[0]).toBeLessThan(
            repository.invalidatePendingByUserId.mock.invocationCallOrder[0]!,
        )
    })

    it('answers the refusal of `check` and neither retires nor makes a token', async () => {
        lockById.mockResolvedValue(lockedUser())
        const refusal = conflict('no')
        const { issueTokenLocked } = await load()

        const result = await issueTokenLocked(repository, {
            userId: 7n,
            ttlMs: 1,
            check: () => Result.err(refusal),
        })

        expect(Result.isError(result) && result.error).toEqual(refusal)
        expect(repository.invalidatePendingByUserId).not.toHaveBeenCalled()
        expect(repository.create).not.toHaveBeenCalled()
    })

    it('answers not found for a user that no longer exists, and makes nothing', async () => {
        lockById.mockResolvedValue(undefined)
        const check = vi.fn()
        const { issueTokenLocked } = await load()

        const result = await issueTokenLocked(repository, { userId: 7n, ttlMs: 1, check })

        expect(Result.isError(result) && result.error).toMatchObject({ _tag: 'NotFound' })
        expect(check).not.toHaveBeenCalled()
        expect(repository.invalidatePendingByUserId).not.toHaveBeenCalled()
        expect(repository.create).not.toHaveBeenCalled()
    })

    // ADR 0004: a storage failure propagates; nothing is made after a failed retire.
    it('rejects when retiring fails, and makes nothing', async () => {
        const dbError = new Error('db')
        lockById.mockResolvedValue(lockedUser())
        repository.invalidatePendingByUserId.mockRejectedValue(dbError)
        const { issueTokenLocked } = await load()
        await expect(issueTokenLocked(repository, { userId: 7n, ttlMs: 1 })).rejects.toBe(dbError)
        expect(repository.create).not.toHaveBeenCalled()
    })

    it('rejects when making the token fails', async () => {
        const dbError = new Error('db')
        lockById.mockResolvedValue(lockedUser())
        repository.invalidatePendingByUserId.mockResolvedValue(0)
        repository.create.mockRejectedValue(dbError)
        const { issueTokenLocked } = await load()
        await expect(issueTokenLocked(repository, { userId: 7n, ttlMs: 1 })).rejects.toBe(dbError)
    })

    it('rejects when the lock fails, and touches no token', async () => {
        const dbError = new Error('lock')
        lockById.mockRejectedValue(dbError)
        const { issueTokenLocked } = await load()
        await expect(issueTokenLocked(repository, { userId: 7n, ttlMs: 1 })).rejects.toBe(dbError)
        expect(repository.invalidatePendingByUserId).not.toHaveBeenCalled()
        expect(repository.create).not.toHaveBeenCalled()
    })
})

describe('findUsableToken', () => {
    const answers = {
        used: badRequest('used'),
        expired: badRequest('expired'),
    }
    const row = (over: Record<string, unknown> = {}) => ({
        id: 11n,
        userId: 7n,
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
        expect(repository.burn).not.toHaveBeenCalled()
        expect(repository.markUsed).not.toHaveBeenCalled()
    })

    it('burns an expired token and answers `expired`', async () => {
        repository.findByTokenHash.mockResolvedValue(row({ expiresAt: new Date(Date.now() - 1) }))
        repository.burn.mockResolvedValue(undefined)
        const { findUsableToken } = await load()
        const result = await findUsableToken(repository, 'secret', answers)
        expect(Result.isError(result) && result.error).toEqual(badRequest('expired'))
        expect(repository.burn).toHaveBeenCalledWith(11n)
        // Burning is not the consuming claim: that one refuses an expired token.
        expect(repository.markUsed).not.toHaveBeenCalled()
    })

    it('rejects when the lookup or the burning fails', async () => {
        const { findUsableToken } = await load()
        const lookupError = new Error('db lookup')
        repository.findByTokenHash.mockRejectedValue(lookupError)
        await expect(findUsableToken(repository, 'secret', answers)).rejects.toBe(lookupError)

        const burnError = new Error('db burn')
        repository.findByTokenHash.mockResolvedValue(row({ expiresAt: new Date(Date.now() - 1) }))
        repository.burn.mockRejectedValue(burnError)
        await expect(findUsableToken(repository, 'secret', answers)).rejects.toBe(burnError)
    })
})

describe('runTokenTransaction', () => {
    const token = (over: Record<string, unknown> = {}) => ({
        id: 11n,
        userId: 7n,
        usedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
        ...over,
    })

    it('locks, consumes, applies and retires the other tokens in that order, in one transaction', async () => {
        const user = lockedUser()
        lockById.mockResolvedValue(user)
        repository.markUsed.mockResolvedValue(token())
        const apply = vi.fn().mockResolvedValue('done')
        const other = { invalidatePendingByUserId: vi.fn().mockResolvedValue(1) }
        const { runTokenTransaction } = await load()

        const result = await runTokenTransaction(repository, token(), {
            apply,
            invalidate: [repository, other],
        })

        expect(result).toEqual({ kind: 'applied', value: 'done' })
        expect(lockById).toHaveBeenCalledWith(7n, TX)
        expect(repository.markUsed).toHaveBeenCalledTimes(1)
        expect(repository.markUsed).toHaveBeenCalledWith(11n, TX)
        expect(apply).toHaveBeenCalledWith(user, TX)
        expect(repository.invalidatePendingByUserId).toHaveBeenCalledWith(7n, TX)
        expect(other.invalidatePendingByUserId).toHaveBeenCalledWith(7n, TX)
        expect(lockById.mock.invocationCallOrder[0]).toBeLessThan(
            repository.markUsed.mock.invocationCallOrder[0]!,
        )
        expect(repository.markUsed.mock.invocationCallOrder[0]).toBeLessThan(
            apply.mock.invocationCallOrder[0]!,
        )
        expect(apply.mock.invocationCallOrder[0]).toBeLessThan(
            repository.invalidatePendingByUserId.mock.invocationCallOrder[0]!,
        )
        expect(apply.mock.invocationCallOrder[0]).toBeLessThan(
            other.invalidatePendingByUserId.mock.invocationCallOrder[0]!,
        )
    })

    it('retires nothing when no table is named', async () => {
        lockById.mockResolvedValue(lockedUser())
        repository.markUsed.mockResolvedValue(token())
        const { runTokenTransaction } = await load()

        const result = await runTokenTransaction(repository, token(), {
            apply: () => Promise.resolve(undefined),
        })

        expect(result.kind).toBe('applied')
        expect(repository.invalidatePendingByUserId).not.toHaveBeenCalled()
    })

    it('checks the locked row before consuming and applies when it allows', async () => {
        const user = lockedUser()
        lockById.mockResolvedValue(user)
        repository.markUsed.mockResolvedValue(token())
        const check = vi.fn().mockResolvedValue(Result.ok(undefined))
        const apply = vi.fn().mockResolvedValue(undefined)
        const { runTokenTransaction } = await load()

        const result = await runTokenTransaction(repository, token(), { check, apply })

        expect(result.kind).toBe('applied')
        expect(check).toHaveBeenCalledWith(user, TX)
        expect(lockById.mock.invocationCallOrder[0]).toBeLessThan(
            check.mock.invocationCallOrder[0]!,
        )
        expect(check.mock.invocationCallOrder[0]).toBeLessThan(
            repository.markUsed.mock.invocationCallOrder[0]!,
        )
        expect(repository.markUsed).toHaveBeenCalledTimes(1)
    })

    it('consumes the token on a refusal of `check`, answers `rejected` and changes nothing else', async () => {
        lockById.mockResolvedValue(lockedUser())
        repository.markUsed.mockResolvedValue(token())
        const refusal = conflict('taken')
        const apply = vi.fn()
        const { runTokenTransaction } = await load()

        const result = await runTokenTransaction(repository, token(), {
            check: () => Result.err(refusal),
            apply,
            invalidate: [repository],
        })

        expect(result).toEqual({ kind: 'rejected', error: refusal })
        expect(repository.markUsed).toHaveBeenCalledTimes(1)
        expect(repository.markUsed).toHaveBeenCalledWith(11n, TX)
        expect(apply).not.toHaveBeenCalled()
        expect(repository.invalidatePendingByUserId).not.toHaveBeenCalled()
    })

    it('answers `unusable` instead of `rejected` when the refused token was already gone', async () => {
        lockById.mockResolvedValue(lockedUser())
        repository.markUsed.mockResolvedValue(undefined)
        const apply = vi.fn()
        const { runTokenTransaction } = await load()

        const result = await runTokenTransaction(repository, token(), {
            check: () => Result.err(conflict('taken')),
            apply,
        })

        expect(result).toEqual({ kind: 'unusable', reason: 'used' })
        expect(apply).not.toHaveBeenCalled()
    })

    it('does not apply when somebody else used the token first, and says `used`', async () => {
        lockById.mockResolvedValue(lockedUser())
        repository.markUsed.mockResolvedValue(undefined)
        const apply = vi.fn()
        const { runTokenTransaction } = await load()

        const result = await runTokenTransaction(repository, token(), {
            apply,
            invalidate: [repository],
        })

        expect(result).toEqual({ kind: 'unusable', reason: 'used' })
        expect(apply).not.toHaveBeenCalled()
        expect(repository.invalidatePendingByUserId).not.toHaveBeenCalled()
    })

    it('says `expired` when the token expired while waiting for the lock', async () => {
        lockById.mockResolvedValue(lockedUser())
        repository.markUsed.mockResolvedValue(undefined)
        const apply = vi.fn()
        const { runTokenTransaction } = await load()

        const result = await runTokenTransaction(
            repository,
            token({ expiresAt: new Date(Date.now() - 1) }),
            { apply },
        )

        expect(result).toEqual({ kind: 'unusable', reason: 'expired' })
        expect(apply).not.toHaveBeenCalled()
    })

    it('answers `user_missing` for a user that no longer exists, and touches nothing', async () => {
        lockById.mockResolvedValue(undefined)
        const check = vi.fn()
        const apply = vi.fn()
        const { runTokenTransaction } = await load()

        const result = await runTokenTransaction(repository, token(), {
            check,
            apply,
            invalidate: [repository],
        })

        expect(result).toEqual({ kind: 'user_missing' })
        expect(check).not.toHaveBeenCalled()
        expect(repository.markUsed).not.toHaveBeenCalled()
        expect(apply).not.toHaveBeenCalled()
        expect(repository.invalidatePendingByUserId).not.toHaveBeenCalled()
    })

    it('rejects with the original error when apply fails (a unique violation is read from it)', async () => {
        lockById.mockResolvedValue(lockedUser())
        repository.markUsed.mockResolvedValue(token())
        const cause = Object.assign(new Error('duplicate key'), { code: '23505' })
        const { runTokenTransaction } = await load()
        await expect(
            runTokenTransaction(repository, token(), {
                apply: () => Promise.reject(cause),
                invalidate: [repository],
            }),
        ).rejects.toBe(cause)
        expect(repository.invalidatePendingByUserId).not.toHaveBeenCalled()
    })
})
