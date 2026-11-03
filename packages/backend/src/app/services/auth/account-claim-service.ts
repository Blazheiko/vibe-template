import { nanoid } from 'nanoid'
import logger from '#logger'
import {
    emailLinkVerificationRepository,
    emailVerificationRepository,
    oauthAccountRepository,
    oauthLinkVerificationRepository,
    passwordResetRepository,
    pushSubscriptionRepository,
    smsAuthChallengeRepository,
    userRepository,
    type UserRow,
} from '#app/repositories/index.js'
import type { DbTransaction } from '#app/repositories/transaction.js'
import {
    LINK_PHONE_FLOW,
    normalizeEmail,
    RESET_PHONE_FLOW,
} from '#app/services/auth/auth-normalize.js'
import { destroyAllSessions } from '#vendor/utils/session/redis-session-storage.js'

// feat-097: an account whose address was never verified may have been created by somebody
// who does not own that mailbox. The first proof of owning the mailbox (an authoritative
// Google sign-in, a confirmed OAuth link, a password reset by mail) hands the account to the
// owner and takes away everything that existed before the address was proven.

/** Every one-time token table: all of a claimed account's pending tokens are retired. */
export const ALL_TOKEN_REPOSITORIES = [
    emailVerificationRepository,
    emailLinkVerificationRepository,
    passwordResetRepository,
    oauthLinkVerificationRepository,
] as const

/** Whether the locked row still has the address the proof is about (claim step 2). */
export function addressMatches(user: UserRow, provenEmail: string): boolean {
    return user.email !== null && normalizeEmail(user.email) === normalizeEmail(provenEmail)
}

/** Retires the pending SMS challenges of a phone, in `executor`'s transaction when given. */
export async function invalidatePendingPhoneChallenges(
    phone: string,
    executor?: DbTransaction,
): Promise<void> {
    // One after the other: inside a transaction both statements share one connection.
    await smsAuthChallengeRepository.invalidatePendingForPhoneFlow(
        phone,
        RESET_PHONE_FLOW,
        executor,
    )
    await smsAuthChallengeRepository.invalidatePendingForPhoneFlow(phone, LINK_PHONE_FLOW, executor)
}

// ADR 0002: the rotated sessionToken is the revocation; deleting the old records is memory
// cleanup. A failure is logged and must not fail an operation that has been committed.
export async function destroySessionsQuietly(
    previousSessionToken: string,
    userId: bigint,
): Promise<void> {
    try {
        const cleanup = await destroyAllSessions(previousSessionToken)
        if (!cleanup.complete) {
            logger.warn(
                { userId: String(userId), deleted: cleanup.deleted },
                'Not every previous session deleted after a password reset',
            )
        }
    } catch (err: unknown) {
        logger.warn(
            { err, userId: String(userId) },
            'Previous sessions not deleted after a password reset',
        )
    }
}

export interface ClaimOutcome {
    /** False: the address was verified already, nothing was taken away. */
    claimed: boolean
    user: UserRow
    /** The token whose sessions are revoked by the claim (destroy them after commit). */
    previousSessionToken: string
}

/**
 * The claim itself, on a row the caller locked (`userRepository.lockById`) and whose address
 * it checked (`addressMatches`), inside the caller's transaction. When the address is not yet
 * verified: mark it verified, drop the password (or set `newPasswordHash`, for a reset), the
 * phone, every OAuth link and push subscription, retire every pending token and SMS challenge,
 * and rotate the sessionToken. Otherwise only `newPasswordHash` is applied, if given.
 */
export async function claimLocked(
    tx: DbTransaction,
    user: UserRow,
    options: { newPasswordHash?: string } = {},
): Promise<ClaimOutcome> {
    if (user.emailVerifiedAt !== null) {
        if (options.newPasswordHash === undefined) {
            return { claimed: false, user, previousSessionToken: user.sessionToken }
        }
        const updated = await userRepository.update(
            user.id,
            { password: options.newPasswordHash, sessionToken: nanoid() },
            tx,
        )
        if (updated === undefined) throw new Error('User disappeared during the claim')
        return { claimed: false, user: updated, previousSessionToken: user.sessionToken }
    }

    const updated = await userRepository.update(
        user.id,
        {
            emailVerifiedAt: new Date(),
            password: options.newPasswordHash ?? null,
            phone: null,
            sessionToken: nanoid(),
        },
        tx,
    )
    if (updated === undefined) throw new Error('User disappeared during the claim')

    await oauthAccountRepository.deleteByUserId(user.id, tx)
    await pushSubscriptionRepository.deleteByUserId(user.id, tx)
    for (const repository of ALL_TOKEN_REPOSITORIES) {
        await repository.invalidatePendingByUserId(user.id, tx)
    }
    if (user.phone !== null && user.phone !== '') {
        await invalidatePendingPhoneChallenges(user.phone, tx)
    }

    logger.info({ userId: String(user.id) }, 'unverified account claimed by the mailbox owner')
    return { claimed: true, user: updated, previousSessionToken: user.sessionToken }
}
