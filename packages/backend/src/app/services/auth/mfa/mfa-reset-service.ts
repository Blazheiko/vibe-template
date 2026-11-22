import { Result } from 'better-result'
import { nanoid } from 'nanoid'
import { MFA_REASONS, type SessionAuthState } from 'shared/mfa'

import {
    recoveryCodeRepository,
    totpFactorRepository,
    userRepository,
    webauthnCredentialRepository,
    withTransaction,
} from '#app/repositories/index.js'
import { auditService, type RecordedAuditEvent } from '#app/services/audit/audit-service.js'
import {
    withProof,
    withRole,
    type SystemAuditActor,
    type UserAuditActor,
} from '#app/services/audit/audit-actor.js'
import { signInCapability } from '#app/services/auth/sign-in-methods-service.js'
import { wsSessionRevocation } from '#app/services/auth/ws-session-revocation.js'
import { conflict, forbidden, notFound, type AppResult } from '#app/services/shared/errors.js'
import logger from '#vendor/utils/logger.js'
import { destroyAllSessions } from '#vendor/utils/session/redis-session-storage.js'
import { retirePendingContactLinks } from './contact-links.js'
import { loadMfaAccount } from './mfa-account.js'
import { announceMfaChange } from './mfa-notice.js'
import { auditProofOf, requireProof } from './require-proof.js'
import { staffPolicy } from './staff-policy.js'

// feat-247 (docs/plan/passkeys-mfa-plan.md, Р12, Р13): an administrator (users.mfa.reset, row 10
// of Р3) or the CLI removes every second factor and recovery code of another account. The account
// keeps its password and its social sign-ins; the reset is refused, without exception, when it
// would leave no way to sign in (a passkey-only account sets a password through "forgot password"
// first). The session token rotates in the same transaction: every session and socket ends.

export interface MfaResetOutcome {
    userId: bigint
    removed: { totp: boolean; passkeys: number; recoveryCodes: number }
}

export const mfaResetService = {
    async reset(input: {
        actor: UserAuditActor | SystemAuditActor
        targetUserId: bigint
        reason: string
        /** The auth state of the admin's session (row 10); the CLI has none and is not asked. */
        sessionAuth?: SessionAuthState | undefined
        now?: number
    }): Promise<AppResult<MfaResetOutcome>> {
        const { targetUserId } = input
        const reason = input.reason.trim()
        let actor = input.actor

        if (actor.kind === 'user') {
            // Р13: not one's own factors: a recovery code or the CLI is the way for that.
            if (actor.userId === targetUserId) {
                return Result.err(forbidden('Reset your own factors with a recovery code'))
            }
            const actorUser = await userRepository.findById(actor.userId)
            if (actorUser === undefined) return Result.err(forbidden('Access denied'))
            const proof = requireProof({
                action: 'mfa.reset_other',
                account: await loadMfaAccount(actorUser),
                auth: input.sessionAuth,
                staffStepUpProofs: staffPolicy().stepUpProofs,
                ...(input.now !== undefined ? { now: input.now } : {}),
            })
            if (Result.isError(proof)) return Result.err(proof.error)
            actor = withProof(actor, auditProofOf(input.sessionAuth))
        }

        let events: RecordedAuditEvent[] = []
        const result = await withTransaction(async (tx): Promise<AppResult<MfaResetOutcome>> => {
            const locked = await userRepository.lockById(targetUserId, tx)
            if (locked === undefined) return Result.err(notFound('User', 'User not found'))

            // Р12: the state after the reset (no passkeys) must still sign in. No exception for
            // an administrator or the CLI.
            const before = await loadMfaAccount(locked, tx)
            const capability = await signInCapability(locked, tx, {
                removePasskeys: before.passkeys,
            })
            if (!capability.canSignIn) {
                return Result.err(
                    conflict(
                        'The account would have no way to sign in: the user sets a password first ("forgot password")',
                        MFA_REASONS.lastSignInMethod,
                    ),
                )
            }

            const totp = await totpFactorRepository.deleteByUserId(targetUserId, tx)
            const passkeys = await webauthnCredentialRepository.deleteAllOfUser(targetUserId, tx)
            const recoveryCodes = await recoveryCodeRepository.deleteByUserId(targetUserId, tx)
            await retirePendingContactLinks(targetUserId, tx)
            const rotated = await userRepository.updateIfSessionToken(
                targetUserId,
                locked.sessionToken,
                { sessionToken: nanoid() },
                tx,
            )
            if (rotated === undefined) throw new Error('session token changed under the lock')

            const stamp = await auditService.stamp(tx)
            events = await auditService.record(
                tx,
                stamp,
                actor.kind === 'user' ? withRole(actor, actor.role ?? 'admin') : actor,
                [
                    {
                        action: 'auth.mfa.reset',
                        targetId: String(targetUserId),
                        targetUserId,
                        input: { reason, mfaRemoved: totp || passkeys > 0 || recoveryCodes > 0 },
                    },
                ],
            )
            return Result.ok({ userId: targetUserId, removed: { totp, passkeys, recoveryCodes } })
        })
        if (Result.isError(result)) return Result.err(result.error)

        auditService.logCommitted(input.actor.logger, events)
        // The token rotated: every socket of the account closes (other instances on their
        // periodic pass), and the session records go.
        wsSessionRevocation.closeUserConnections(String(targetUserId))
        try {
            await destroyAllSessions(String(targetUserId))
        } catch (err) {
            logger.warn(
                { err, userId: String(targetUserId) },
                'Sessions not deleted after MFA reset',
            )
        }
        announceMfaChange(targetUserId, 'reset')
        return result
    },
}
