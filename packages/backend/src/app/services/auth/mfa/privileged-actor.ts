import { Result } from 'better-result'
import { roleHasPermission, type Permission } from 'shared/access'
import type { AcceptedProof, SessionAuthState } from 'shared/mfa'

import type { DbExecutor, UserRow } from '#app/repositories/index.js'
import { forbidden, sessionRevoked, type AppResult } from '#app/services/shared/errors.js'
import { safeEqual } from '#vendor/utils/helpers/safe-equal.js'
import { loadMfaAccount } from './mfa-account.js'
import { requireProof } from './require-proof.js'
import { staffPolicy } from './staff-policy.js'

// docs/plan/passkeys-mfa-plan.md (rows 9–10 of Р3, Р13): a role change or an MFA reset of another
// account is decided at the write, not when the request came in. The guard and the early proof
// check read the actor before the transaction; meanwhile its session may have been revoked
// (logout everywhere, a password change, a reset of its own factors) or its role lowered. Under
// the actor's row lock the caller asks this again, and only a user actor (the CLI is not asked).
//
// Ending one session from the session list, a plain logout of the session itself, and a new
// sign-in in the same browser that replaces it, delete its record without rotating
// users.session_token, so the token alone does not see it. All delete the record under the same
// row lock (session-list-service `underUserRowLock`; the logout and the sign-in through the hook
// app/start registers for the session layer, vendor session-deletion-lock), and the record of the
// request's session is read here while the caller holds the lock: either the deletion came first
// (401) or it waits until the privileged write has committed. A deletion whose wait is cut never
// deletes without the lock: it is refused as retryable.

export interface PrivilegedActorCheck {
    /** The actor's row, locked FOR UPDATE in the caller's transaction (undefined: it is gone). */
    actorRow: UserRow | undefined
    /** The session token the request presented (`Auth.getPresentedUserToken`). */
    presentedSessionToken: string | undefined
    /**
     * Whether the record of the request's session still exists (`context.session.isStored()`).
     * Required for a user actor: undefined is refused as a revoked session.
     */
    sessionStored: (() => Promise<boolean>) | undefined
    permission: Permission
    action: 'role.assign' | 'mfa.reset_other'
    sessionAuth: SessionAuthState | undefined
    now?: number | undefined
    tx: DbExecutor
}

/**
 * 401 `session_revoked` when the actor's session token is no longer the one the request
 * presented or the request's session record is gone (called under the actor's row lock), 403 when the actor lost the permission, the 403 of the proof matrix when its proof
 * no longer holds (the factors read under the lock); otherwise the proof that allowed the action.
 */
export async function recheckPrivilegedActor(
    check: PrivilegedActorCheck,
): Promise<AppResult<AcceptedProof>> {
    const { actorRow, presentedSessionToken } = check
    if (
        actorRow === undefined ||
        presentedSessionToken === undefined ||
        !safeEqual(actorRow.sessionToken, presentedSessionToken)
    ) {
        return Result.err(sessionRevoked())
    }
    if (check.sessionStored === undefined || !(await check.sessionStored())) {
        return Result.err(sessionRevoked())
    }
    if (!roleHasPermission(actorRow.role, check.permission)) {
        return Result.err(forbidden('Access denied'))
    }
    return requireProof({
        action: check.action,
        account: await loadMfaAccount(actorRow, check.tx),
        auth: check.sessionAuth,
        staffStepUpProofs: staffPolicy().stepUpProofs,
        ...(check.now !== undefined ? { now: check.now } : {}),
    })
}
