import { nanoid } from 'nanoid'
import logger from '#logger'
import {
    emailLinkVerificationRepository,
    emailVerificationRepository,
    oauthAccountRepository,
    oauthLinkVerificationRepository,
    passwordResetRepository,
    pushSubscriptionRepository,
    userRepository,
    type UserRow,
    recoveryCodeRepository,
    webauthnCredentialRepository,
    totpFactorRepository,
} from '#app/repositories/index.js'
import type { DbTransaction } from '#app/repositories/transaction.js'
import type { AuditEventInput } from '#app/services/audit/audit-service.js'
import { normalizeEmail } from '#app/services/auth/auth-normalize.js'
import { destroyAllSessions } from '#vendor/utils/session/redis-session-storage.js'
import { invalidatePendingPhoneChallenges } from '#app/services/auth/phone-challenges.js'
import { wsSessionRevocation } from '#app/services/auth/ws-session-revocation.js'
import { toEntityId, type UserId } from '#app/domain/ids.js'

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

// Moved to phone-challenges.ts (feat-121) so auth-service can use it without this module.
export { invalidatePendingPhoneChallenges }

// ADR 0002: the rotated sessionToken is the revocation; deleting the old records is memory
// cleanup. A failure is logged and must not fail an operation that has been committed.
// feat-195: the WebSocket connections opened from those sessions are closed first.
export async function destroySessionsQuietly(
    previousSessionToken: string,
    userId: UserId,
): Promise<void> {
    wsSessionRevocation.closeUserConnections(toEntityId(userId))
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

/**
 * What a claim took away (feat-235, Р4), read from the row before the change and from the rows the
 * claim itself deleted, so the audit event cannot disagree with what happened.
 */
export interface ClaimEffects {
    /** The account had a password before; it no longer works (dropped, or replaced by a reset). */
    passwordCleared: boolean
    phoneRemoved: boolean
    /** The provider of every OAuth link removed. */
    oauthRemoved: string[]
    pushSubscriptionsRemoved: number
    /** feat-245: a TOTP factor or recovery codes were removed. */
    mfaRemoved: boolean
}

export interface ClaimOutcome {
    /** False: the address was verified already, nothing was taken away. */
    claimed: boolean
    user: UserRow
    /** The token whose sessions are revoked by the claim (destroy them after commit). */
    previousSessionToken: string
    /** Set when `claimed`. */
    effects: ClaimEffects | null
}

/** The `auth.account.claimed` event of a claim; none when nothing was claimed. */
export function claimEvent(outcome: ClaimOutcome): AuditEventInput[] {
    if (!outcome.claimed || outcome.effects === null) return []
    return [
        {
            action: 'auth.account.claimed',
            targetId: String(outcome.user.id),
            targetUserId: outcome.user.id,
            input: outcome.effects,
        },
    ]
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
            return { claimed: false, user, previousSessionToken: user.sessionToken, effects: null }
        }
        const updated = await userRepository.update(
            user.id,
            { password: options.newPasswordHash, sessionToken: nanoid() },
            tx,
        )
        if (updated === undefined) throw new Error('User disappeared during the claim')
        return {
            claimed: false,
            user: updated,
            previousSessionToken: user.sessionToken,
            effects: null,
        }
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

    const oauthRemoved = await oauthAccountRepository.deleteByUserId(user.id, tx)
    // feat-245 (Р9): a second factor set up before the address was proven goes with the rest, or
    // whoever registered somebody else's address would keep a factor of the owner's account.
    const totpRemoved = await totpFactorRepository.deleteByUserId(user.id, tx)
    const recoveryCodesRemoved = await recoveryCodeRepository.deleteByUserId(user.id, tx)
    // feat-246 (Р9): the passkeys and the WebAuthn user handle go with the other factors.
    const passkeysRemoved = await webauthnCredentialRepository.deleteAllOfUser(user.id, tx)
    const pushSubscriptionsRemoved = await pushSubscriptionRepository.deleteByUserId(user.id, tx)
    for (const repository of ALL_TOKEN_REPOSITORIES) {
        await repository.invalidatePendingByUserId(user.id, tx)
    }
    if (user.phone !== null && user.phone !== '') {
        await invalidatePendingPhoneChallenges(user.phone, tx)
    }

    logger.info({ userId: String(user.id) }, 'unverified account claimed by the mailbox owner')
    return {
        claimed: true,
        user: updated,
        previousSessionToken: user.sessionToken,
        effects: {
            passwordCleared: user.password !== null && user.password !== '',
            phoneRemoved: user.phone !== null && user.phone !== '',
            oauthRemoved,
            pushSubscriptionsRemoved,
            mfaRemoved: totpRemoved || recoveryCodesRemoved > 0 || passkeysRemoved > 0,
        },
    }
}
