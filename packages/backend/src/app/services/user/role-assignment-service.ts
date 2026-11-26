import { Result } from 'better-result'
import type { SessionToken } from '#app/domain/secrets.js'
import { canAssignRole, isStaffRole, type Role } from 'shared/access'
import { MFA_REASONS } from 'shared/mfa'
import type { SessionAuthState } from 'shared/mfa'

import mfaConfig from '#config/mfa.js'

import { userRepository } from '#app/repositories/index.js'
import { auditService, type RecordedAuditEvent } from '#app/services/audit/audit-service.js'
import {
    withRole,
    type AuditActor,
    type SystemAuditActor,
    type UserAuditActor,
} from '#app/services/audit/audit-actor.js'
import { announceRoleChanged } from '#app/services/communication/role-change-announcer.js'
import {
    conflict,
    forbidden,
    notFound,
    type AppError,
    type AppResult,
} from '#app/services/shared/errors.js'
import { withTransactionResult } from '#app/services/shared/transaction-result.js'
import { loadMfaAccount, loadMfaFactors } from '#app/services/auth/mfa/mfa-account.js'
import { recheckPrivilegedActor } from '#app/services/auth/mfa/privileged-actor.js'
import { requireProof } from '#app/services/auth/mfa/require-proof.js'
import { staffPolicy } from '#app/services/auth/mfa/staff-policy.js'
import type { UserId } from '#app/domain/ids.js'

/** A role change by an admin (HTTP, feat-241) or by the user:set-role CLI (feat-240). */
export type RoleAssignmentActor = UserAuditActor | SystemAuditActor

export interface RoleAssignment {
    userId: UserId
    role: Role
    /** False when the user already had the role: nothing was written. */
    changed: boolean
}

const denied = (): AppError => forbidden('Access denied')

/**
 * Changes the role of a user (feat-240, docs/plan/roles-permissions-plan.md Р6). Every change runs
 * under one advisory lock, so changes are serialized. Under it the rows of the actor and the target
 * are locked in ascending id order (the order an MFA reset takes them too) and read again: the
 * permission guard read the actor before the transaction, and since then its session may have been
 * revoked (401 session_revoked), its role lowered or its proof gone (403). The target's lock holds
 * off a parallel removal of its last factor (which locks the same row) until the change commits.
 *
 * Rules: the target exists (404); a user actor has users.roles.assign, does not change its own
 * role and may give and take only roles of its delegation policy (403); the same role is a no-op;
 * a staff role needs a verified email (409 identity_unverified) and, while MFA_REQUIRED_FOR_STAFF is
 * on, a second factor of the staff policy (409 mfa_not_enrolled, feat-247 Р10); the last admin
 * keeps the role (409 last_admin). The change and its audit event commit together.
 */
export const roleAssignmentService = {
    async assign(input: {
        actor: RoleAssignmentActor
        targetUserId: UserId
        role: Role
        /**
         * feat-247 (row 9 of Р3): the auth state of the session of a user actor. A role change
         * needs a fresh proof of the actor (a factor of the staff policy once the actor has MFA).
         * The CLI (a system actor) has no session and is not asked.
         */
        sessionAuth?: SessionAuthState | undefined
        /** The session token the request of a user actor presented; checked under the lock. */
        presentedSessionToken?: SessionToken | undefined
        /**
         * Whether the record of the request's session still exists (`context.session.isStored()`),
         * read under the actor's row lock. Required for a user actor: without it the change is
         * refused with 401 session_revoked. The CLI has no session.
         */
        sessionStored?: (() => Promise<boolean>) | undefined
        now?: number
    }): Promise<AppResult<RoleAssignment>> {
        const { targetUserId, role } = input
        let { actor } = input
        let events: RecordedAuditEvent[] = []

        if (actor.kind === 'user') {
            const actorUser = await userRepository.findById(actor.userId)
            if (actorUser === undefined) return Result.err(denied())
            const proof = requireProof({
                action: 'role.assign',
                account: await loadMfaAccount(actorUser),
                auth: input.sessionAuth,
                staffStepUpProofs: staffPolicy().stepUpProofs,
                ...(input.now !== undefined ? { now: input.now } : {}),
            })
            if (Result.isError(proof)) return Result.err(proof.error)
            actor = { ...actor, proof: proof.value }
        }

        const result = await withTransactionResult(
            async (tx): Promise<AppResult<RoleAssignment>> => {
                await userRepository.lockRoleChanges(tx)

                const locked = await userRepository.lockManyById(
                    actor.kind === 'user' ? [targetUserId, actor.userId] : [targetUserId],
                    tx,
                )
                const target = locked.get(targetUserId)
                if (target === undefined) return Result.err(notFound('User', 'User not found'))

                let auditActor: AuditActor = actor
                if (actor.kind === 'user') {
                    if (actor.userId === targetUserId) return Result.err(denied())
                    const actorRow = locked.get(actor.userId)
                    const proof = await recheckPrivilegedActor({
                        actorRow,
                        presentedSessionToken: input.presentedSessionToken,
                        sessionStored: input.sessionStored,
                        permission: 'users.roles.assign',
                        action: 'role.assign',
                        sessionAuth: input.sessionAuth,
                        now: input.now,
                        tx,
                    })
                    if (Result.isError(proof)) return Result.err(proof.error)
                    if (
                        actorRow === undefined ||
                        !canAssignRole(actorRow.role, target.role, role)
                    ) {
                        return Result.err(denied())
                    }
                    // The role and the proof the actor holds now, not the ones read before.
                    auditActor = withRole({ ...actor, proof: proof.value }, actorRow.role)
                }

                if (target.role === role) {
                    return Result.ok({ userId: targetUserId, role, changed: false })
                }
                if (role !== 'user' && target.emailVerifiedAt === null) {
                    return Result.err(
                        conflict('A staff role needs a verified email', 'identity_unverified'),
                    )
                }
                if (mfaConfig.requiredForStaff && isStaffRole(role)) {
                    // feat-247 (Р10): no staff account exists without MFA, so a first factor
                    // cannot be set up by someone who knows only the password. Read under the
                    // target's row lock: a removal of its last factor waits for this change and
                    // then sees the staff role. Lowering to a role without permissions is always
                    // allowed.
                    const factors = await loadMfaFactors(targetUserId, tx)
                    const enrolled = staffPolicy().enrolled({
                        totp: factors.totp !== undefined,
                        passkeys: factors.passkeys,
                    })
                    if (!enrolled) {
                        return Result.err(
                            conflict(
                                'A staff role needs a second factor: the account sets one up first',
                                MFA_REASONS.mfaNotEnrolled,
                            ),
                        )
                    }
                }
                if (
                    target.role === 'admin' &&
                    (await userRepository.countByRole('admin', tx)) <= 1
                ) {
                    return Result.err(
                        conflict('The last administrator keeps the role', 'last_admin'),
                    )
                }

                const updated = await userRepository.updateRole(targetUserId, role, tx)
                if (updated === undefined)
                    throw new Error('User disappeared during the role change')
                const stamp = await auditService.stamp(tx)
                events = await auditService.record(tx, stamp, auditActor, [
                    {
                        action: 'user.role.changed',
                        targetId: String(targetUserId),
                        targetUserId,
                        input: { from: target.role, to: updated },
                    },
                ])
                return Result.ok({ userId: targetUserId, role: updated, changed: true })
            },
        )

        if (Result.isOk(result) && result.value.changed) {
            auditService.logCommitted(actor.logger, events)
            announceRoleChanged(targetUserId)
        }
        return result
    },
}
