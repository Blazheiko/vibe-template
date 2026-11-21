import { Result } from 'better-result'
import { canAssignRole, roleHasPermission, type Role } from 'shared/access'

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

/** A role change by an admin (HTTP, feat-241) or by the user:set-role CLI (feat-240). */
export type RoleAssignmentActor = UserAuditActor | SystemAuditActor

export interface RoleAssignment {
    userId: bigint
    role: Role
    /** False when the user already had the role: nothing was written. */
    changed: boolean
}

const denied = (): AppError => forbidden('Access denied')

/**
 * Changes the role of a user (feat-240, docs/plan/roles-permissions-plan.md Р6). Every change runs
 * under one advisory lock, so changes are serialized without locking rows in any order. Under it
 * the actor and the target are read again: the permission guard read the actor's role before the
 * transaction, and the actor may have been lowered since.
 *
 * Rules: the target exists (404); a user actor has users.roles.assign, does not change its own
 * role and may give and take only roles of its delegation policy (403); the same role is a no-op;
 * a staff role needs a verified email (409 identity_unverified); the last admin keeps the role
 * (409 last_admin). The change and its audit event commit together.
 */
export const roleAssignmentService = {
    async assign(input: {
        actor: RoleAssignmentActor
        targetUserId: bigint
        role: Role
    }): Promise<AppResult<RoleAssignment>> {
        const { actor, targetUserId, role } = input
        let events: RecordedAuditEvent[] = []

        const result = await withTransactionResult(
            async (tx): Promise<AppResult<RoleAssignment>> => {
                await userRepository.lockRoleChanges(tx)

                const target = await userRepository.findRoleSubject(targetUserId, tx)
                if (target === undefined) return Result.err(notFound('User', 'User not found'))

                let auditActor: AuditActor = actor
                if (actor.kind === 'user') {
                    if (actor.userId === targetUserId) return Result.err(denied())
                    const actorRow = await userRepository.findRoleSubject(actor.userId, tx)
                    if (
                        actorRow === undefined ||
                        !roleHasPermission(actorRow.role, 'users.roles.assign') ||
                        !canAssignRole(actorRow.role, target.role, role)
                    ) {
                        return Result.err(denied())
                    }
                    // The role the actor holds now, not the one the guard read.
                    auditActor = withRole(actor, actorRow.role)
                }

                if (target.role === role) {
                    return Result.ok({ userId: targetUserId, role, changed: false })
                }
                if (role !== 'user' && target.emailVerifiedAt === null) {
                    return Result.err(
                        conflict('A staff role needs a verified email', 'identity_unverified'),
                    )
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
