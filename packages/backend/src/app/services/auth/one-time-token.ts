import { createHash, randomBytes } from 'node:crypto'
import { Result } from 'better-result'
import { userRepository, withTransaction, type ITokenRepository } from '#app/repositories/index.js'
import type { DbTransaction } from '#app/repositories/transaction.js'
import type { UserRow } from '#app/repositories/index.js'
import { notFound, type AppError, type AppResult } from '#app/services/shared/errors.js'

// The password reset, e-mail verification and e-mail linking tokens are one kind of thing: a
// random secret mailed to the user, kept as its hash, valid until it expires, used once. What
// differs is only what using it does and the words of the answers.

export function hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex')
}

export function createToken(): string {
    return randomBytes(32).toString('base64url')
}

interface TokenRow {
    id: bigint
    userId: bigint
    usedAt: Date | null
    expiresAt: Date
}

// Any of the token repositories, whatever its row type: used to retire a user's pending
// tokens in several tables at once.
type AnyTokenRepository = Pick<ITokenRepository<unknown, never>, 'invalidatePendingByUserId'>

/**
 * Makes a new token for the user and retires the earlier ones, in ONE transaction under the
 * user's row lock (feat-096): lock → `check` against the current row → retire → insert. Two
 * concurrent requests therefore leave exactly one usable token, and a request that waited
 * for a claim or a revocation sees the row as it is after it. The mail is sent by the caller
 * after this returns (after commit): if sending fails, the earlier link is already retired
 * and the user asks again. `extra` are the columns the table has beyond the common ones (the
 * address of an e-mail link).
 */
export async function issueTokenLocked<TRow, TInsert extends { userId: bigint }>(
    repository: ITokenRepository<TRow, TInsert>,
    options: {
        userId: bigint
        ttlMs: number
        /** Extra columns; a function gets the locked row (e.g. the address the mail goes to). */
        extra?:
            | Omit<TInsert, 'userId' | 'tokenHash' | 'expiresAt'>
            | ((user: UserRow) => Omit<TInsert, 'userId' | 'tokenHash' | 'expiresAt'>)
        /** Whether a token may be issued for the user as locked; an error is the answer. */
        check?: (user: UserRow) => AppResult<void>
        /** Which earlier tokens to retire; by default every pending one of the user. */
        invalidatePending?: (tx: DbTransaction) => Promise<number>
    },
): Promise<AppResult<{ rawToken: string; user: UserRow }>> {
    return await withTransaction(async (tx) => {
        const user = await userRepository.lockById(options.userId, tx)
        if (user === undefined) {
            return Result.err(notFound('User', 'User not found'))
        }

        if (options.check !== undefined) {
            const allowed = options.check(user)
            if (Result.isError(allowed)) return Result.err(allowed.error)
        }

        if (options.invalidatePending !== undefined) {
            await options.invalidatePending(tx)
        } else {
            await repository.invalidatePendingByUserId(options.userId, tx)
        }

        const extra = typeof options.extra === 'function' ? options.extra(user) : options.extra
        const rawToken = createToken()
        await repository.create(
            {
                ...extra,
                userId: options.userId,
                tokenHash: hashToken(rawToken),
                expiresAt: new Date(Date.now() + options.ttlMs),
            } as unknown as TInsert,
            tx,
        )

        return Result.ok({ rawToken, user })
    })
}

/**
 * Finds the token by the secret the user sent and says whether it can still be used. `undefined`
 * is "no such token" (the caller decides what that means: for the verification link it is the
 * cue to look at the other table). A token that was used answers `used`; one that has expired is
 * burnt (marked used, so it is gone for good) and answers `expired`. This is a first look only:
 * `runTokenTransaction` checks again when it consumes the token.
 */
export async function findUsableToken<TRow extends TokenRow, TInsert>(
    repository: ITokenRepository<TRow, TInsert>,
    secret: string,
    answers: {
        used: AppError
        expired: AppError
    },
): Promise<AppResult<TRow | undefined>> {
    const token = await repository.findByTokenHash(hashToken(secret))
    if (token === undefined) {
        return Result.ok(undefined)
    }

    if (token.usedAt !== null) {
        return Result.err(answers.used)
    }

    if (token.expiresAt.getTime() < Date.now()) {
        await repository.burn(token.id)

        return Result.err(answers.expired)
    }

    return Result.ok(token)
}

export type TokenTransactionOutcome<TValue> =
    /** The token was consumed and `apply` committed with it. */
    | { kind: 'applied'; value: TValue }
    /** Used or expired by the time it was consumed; nothing changed. */
    | { kind: 'unusable'; reason: 'used' | 'expired' }
    /** `check` refused against the locked row; the token was consumed, the account not changed. */
    | { kind: 'rejected'; error: AppError }
    /** The token's user no longer exists; nothing changed. */
    | { kind: 'user_missing' }

/**
 * The one owner of the transaction in which a one-time token is used (feat-096). Order:
 *
 * 1. lock the token's user (`FOR UPDATE`): every flow that consumes a token or changes
 *    credentials takes this lock first, so they run one at a time per user;
 * 2. `check` the locked row (e.g. the address is still the one the link was for). A refusal
 *    consumes the token, so it cannot be tried again, and changes nothing else;
 * 3. consume the token: `used_at IS NULL AND expires_at > clock_timestamp()`. If that finds
 *    no row (another request used it, or it expired while waiting for the lock) nothing
 *    changes;
 * 4. `apply` the token's effect;
 * 5. retire the user's other pending tokens in `invalidate` (by user, no exception by id: the
 *    consumed token is no longer pending).
 *
 * A throw inside rolls everything back, the token included: the link stays usable. A unique
 * violation is told apart by the caller from the error's `code`.
 */
export async function runTokenTransaction<TRow extends TokenRow, TInsert, TValue>(
    repository: ITokenRepository<TRow, TInsert>,
    token: TRow,
    steps: {
        check?: (user: UserRow, tx: DbTransaction) => AppResult<void> | Promise<AppResult<void>>
        apply: (user: UserRow, tx: DbTransaction) => Promise<TValue>
        invalidate?: readonly AnyTokenRepository[]
    },
): Promise<TokenTransactionOutcome<TValue>> {
    return await withTransaction(async (tx): Promise<TokenTransactionOutcome<TValue>> => {
        const user = await userRepository.lockById(token.userId, tx)
        if (user === undefined) return { kind: 'user_missing' }

        const unusable = (): TokenTransactionOutcome<TValue> => ({
            kind: 'unusable',
            reason: token.expiresAt.getTime() <= Date.now() ? 'expired' : 'used',
        })

        if (steps.check !== undefined) {
            const allowed = await steps.check(user, tx)
            if (Result.isError(allowed)) {
                const consumed = await repository.markUsed(token.id, tx)
                return consumed === undefined
                    ? unusable()
                    : { kind: 'rejected', error: allowed.error }
            }
        }

        const consumed = await repository.markUsed(token.id, tx)
        if (consumed === undefined) return unusable()

        const value = await steps.apply(user, tx)

        for (const other of steps.invalidate ?? []) {
            await other.invalidatePendingByUserId(user.id, tx)
        }

        return { kind: 'applied', value }
    })
}
