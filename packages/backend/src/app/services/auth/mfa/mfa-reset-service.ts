import { Result } from 'better-result'
import { type SessionToken, newSessionToken } from '#app/domain/secrets.js'
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
import { recheckPrivilegedActor } from './privileged-actor.js'
import { requireProof } from './require-proof.js'
import { staffPolicy } from './staff-policy.js'
import { toEntityId, type UserId } from '#app/domain/ids.js'

// feat-247 (docs/plan/passkeys-mfa-plan.md, Р12, Р13): an administrator (users.mfa.reset, row 10
// of Р3) or the CLI removes every second factor and recovery code of another account. The account
// keeps its password and its social sign-ins; the reset is refused, without exception, when it
// would leave no way to sign in (a passkey-only account sets a password through "forgot password"
// first). The session token rotates in the same transaction: every session and socket ends.
// The rows of the admin and the target are locked in ascending id order (as a role change does),
// and the admin's session, permission and proof are checked again under the lock.

export interface MfaResetOutcome {
    userId: UserId
    removed: { totp: boolean; passkeys: number; recoveryCodes: number }
}

export const mfaResetService = {
    async reset(input: {
        actor: UserAuditActor | SystemAuditActor
        targetUserId: UserId
        reason: string
        /** The auth state of the admin's session (row 10); the CLI has none and is not asked. */
        sessionAuth?: SessionAuthState | undefined
        /** The session token the admin's request presented; checked under the lock. */
        presentedSessionToken?: SessionToken | undefined
        /**
         * Whether the record of the request's session still exists (`context.session.isStored()`),
         * read under the actor's row lock. Required for a user actor: without it the change is
         * refused with 401 session_revoked. The CLI has no session.
         */
        sessionStored?: (() => Promise<boolean>) | undefined
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
            actor = withProof(actor, proof.value)
        }

        let events: RecordedAuditEvent[] = []
        // The outcome and the token the target had before the rotation: its session records
        // live under it.
        const result = await withTransaction(
            async (
                tx,
            ): Promise<
                AppResult<{ outcome: MfaResetOutcome; previousSessionToken: SessionToken }>
            > => {
                const rows = await userRepository.lockManyById(
                    actor.kind === 'user' ? [targetUserId, actor.userId] : [targetUserId],
                    tx,
                )
                const locked = rows.get(targetUserId)
                if (locked === undefined) return Result.err(notFound('User', 'User not found'))

                let auditActor: UserAuditActor | SystemAuditActor = actor
                if (actor.kind === 'user') {
                    const actorRow = rows.get(actor.userId)
                    const proof = await recheckPrivilegedActor({
                        actorRow,
                        presentedSessionToken: input.presentedSessionToken,
                        sessionStored: input.sessionStored,
                        permission: 'users.mfa.reset',
                        action: 'mfa.reset_other',
                        sessionAuth: input.sessionAuth,
                        now: input.now,
                        tx,
                    })
                    if (Result.isError(proof)) return Result.err(proof.error)
                    if (actorRow === undefined) return Result.err(forbidden('Access denied'))
                    // The role and the proof the admin holds now, not the ones read before.
                    auditActor = withRole(withProof(actor, proof.value), actorRow.role)
                }

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
                const passkeys = await webauthnCredentialRepository.deleteAllOfUser(
                    targetUserId,
                    tx,
                )
                const recoveryCodes = await recoveryCodeRepository.deleteByUserId(targetUserId, tx)
                await retirePendingContactLinks(targetUserId, tx)
                const rotated = await userRepository.updateIfSessionToken(
                    targetUserId,
                    locked.sessionToken,
                    { sessionToken: newSessionToken() },
                    tx,
                )
                if (rotated === undefined) throw new Error('session token changed under the lock')

                const stamp = await auditService.stamp(tx)
                events = await auditService.record(tx, stamp, auditActor, [
                    {
                        action: 'auth.mfa.reset',
                        targetId: String(targetUserId),
                        targetUserId,
                        input: { reason, mfaRemoved: totp || passkeys > 0 || recoveryCodes > 0 },
                    },
                ])
                return Result.ok({
                    outcome: { userId: targetUserId, removed: { totp, passkeys, recoveryCodes } },
                    previousSessionToken: locked.sessionToken,
                })
            },
        )
        if (Result.isError(result)) return Result.err(result.error)

        auditService.logCommitted(input.actor.logger, events)
        // The token rotated: every socket of the account closes (other instances on their
        // periodic pass), and the session records go.
        wsSessionRevocation.closeUserConnections(toEntityId(targetUserId))
        try {
            await destroyAllSessions(result.value.previousSessionToken)
        } catch (err) {
            logger.warn(
                { err, userId: String(targetUserId) },
                'Sessions not deleted after MFA reset',
            )
        }
        announceMfaChange(targetUserId, 'reset')
        return Result.ok(result.value.outcome)
    },
}
