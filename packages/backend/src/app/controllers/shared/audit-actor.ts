import type { AuditProof } from 'shared/audit'

import type { HttpContext } from '#vendor/types/types.js'
import {
    systemActor,
    type AuditActorRole,
    type ProofHolderAuditActor,
    type UserAuditActor,
} from '#app/services/audit/audit-actor.js'

export { systemActor }

// The role admin_guard read for this request (feat-235, Р6): the actor of an admin route takes it
// from there, without a second query. Keyed by the context, so it lives as long as the request.
const guardedRoles = new WeakMap<object, AuditActorRole>()

/** Called by admin_guard once it has read the role. */
export function rememberActorRole(context: object, role: AuditActorRole): void {
    guardedRoles.set(context, role)
}

type ActorContext = Pick<HttpContext, 'auth' | 'requestId' | 'logger'>

/**
 * The signed-in user of the request. `role` is what admin_guard read on an admin route, else the
 * `role` passed in (from a row the service reads anyway), else null. Throws without a signed-in
 * user: call it after auth_guard.
 */
export function auditActorFrom(
    context: ActorContext,
    role: AuditActorRole | null = null,
): UserAuditActor {
    const userId = context.auth.getUserId()
    if (userId === null) throw new Error('auditActorFrom: no signed-in user')
    return {
        kind: 'user',
        userId: BigInt(userId),
        role: guardedRoles.get(context) ?? role,
        requestId: context.requestId,
        proof: null,
        source: null,
        logger: context.logger,
    }
}

/** A request that acts on an account by a proof alone (a mailed link, an SMS code). */
export function proofHolderActor(
    context: Pick<HttpContext, 'requestId' | 'logger'>,
    proof: AuditProof,
): ProofHolderAuditActor {
    return {
        kind: 'proof_holder',
        userId: null,
        role: null,
        requestId: context.requestId,
        proof,
        source: null,
        logger: context.logger,
    }
}
