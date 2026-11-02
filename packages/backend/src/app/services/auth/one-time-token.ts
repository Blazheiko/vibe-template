import { createHash, randomBytes } from 'node:crypto'
import { Result } from 'better-result'
import { withTransaction, type ITokenRepository } from '#app/repositories/index.js'
import type { DbTransaction } from '#app/repositories/transaction.js'
import type { AppError, AppResult } from '#app/services/shared/errors.js'

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
    usedAt: Date | null
    expiresAt: Date
}

/**
 * Makes a new token for the user and retires the earlier ones, in that order: of the tokens a
 * user holds only the newest works. Returns the secret to put in the mail; the table keeps its
 * hash. `extra` are the columns the table has beyond the common ones (the address of an e-mail
 * link).
 */
export async function issueToken<TRow, TInsert extends { userId: bigint }>(
    repository: ITokenRepository<TRow, TInsert>,
    options: {
        userId: bigint
        ttlMs: number
        extra?: Omit<TInsert, 'userId' | 'tokenHash' | 'expiresAt'>
    },
): Promise<string> {
    await repository.invalidatePendingByUserId(options.userId)

    const rawToken = createToken()
    await repository.create({
        ...options.extra,
        userId: options.userId,
        tokenHash: hashToken(rawToken),
        expiresAt: new Date(Date.now() + options.ttlMs),
    } as unknown as TInsert)

    return rawToken
}

/**
 * Finds the token by the secret the user sent and says whether it can still be used. `undefined`
 * is "no such token" (the caller decides what that means: for the verification link it is the
 * cue to look at the other table). A token that was used answers `used`; one that has expired is
 * burnt (marked used, so it is gone for good) and answers `expired`.
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
        await repository.markUsed(token.id)

        return Result.err(answers.expired)
    }

    return Result.ok(token)
}

/**
 * Claims the token and applies its effect in ONE transaction. The claim is
 * `UPDATE ... SET used_at WHERE used_at IS NULL`: of two concurrent requests with one token
 * exactly one gets the row (`claimed: true`, with what `apply` returned), and a failure inside
 * `apply` rolls the claim back with everything else, so the link stays usable and nothing is
 * half done. `claimed: false`: somebody else used it first. A failed transaction throws (a
 * unique violation is told apart by the caller from the error's `code`).
 */
export function consumeTokenAndApply<TRow extends TokenRow, TInsert, TValue>(
    repository: ITokenRepository<TRow, TInsert>,
    token: TRow,
    apply: (tx: DbTransaction) => Promise<TValue>,
): Promise<{ claimed: false } | { claimed: true; value: TValue }> {
    return withTransaction(async (tx) => {
        const claimed = await repository.markUsed(token.id, undefined, tx)
        if (claimed === undefined) return { claimed: false as const }

        return { claimed: true as const, value: await apply(tx) }
    })
}
