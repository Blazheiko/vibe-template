import { nowUnixMs } from 'shared/brand'
import { roleHasPermission, type Permission } from 'shared/access'
import { parseUserId, type UserId } from '#app/domain/ids.js'
import { MFA_REASONS } from 'shared/mfa'

import type { HttpContext, Middleware } from '#vendor/types/types.js'
import { userRoleService } from '#app/services/user/user-role-service.js'
import { forbidden } from '#app/services/shared/errors.js'
import { appErrorToPayload } from '#app/services/shared/app-error-payload.js'
import { applyAppErrorStatus } from '#app/services/shared/apply-service-status.js'
import { rememberActorRole } from '#app/controllers/shared/audit-actor.js'
import { loadMfaFactors } from '#app/services/auth/mfa/mfa-account.js'
import { staffPolicy, staffSessionMeets } from '#app/services/auth/mfa/staff-policy.js'
import mfaConfig from '#config/mfa.js'

// feat-240 (Р4): the canonical 403 body, the same for every permission, so a refusal never says
// which permission was missing.
function deny(context: HttpContext, reason?: string): void {
    const error = forbidden('Access denied', reason)
    applyAppErrorStatus(context.responseData, error)
    context.responseData.payload = appErrorToPayload(error)
}

/**
 * feat-247 (docs/plan/passkeys-mfa-plan.md, Р10): while MFA_REQUIRED_FOR_STAFF is on, a staff role
 * uses its permissions only with the staff factor (`mfa_required`) and a session that proved it
 * recently (`mfa_session_required`). The reason is the same for every permission. Null: passes.
 */
async function staffMfaRefusal(context: HttpContext, userId: UserId): Promise<string | null> {
    if (!mfaConfig.requiredForStaff) return null
    const factors = await loadMfaFactors(userId)
    if (!staffPolicy().enrolled({ totp: factors.totp !== undefined, passkeys: factors.passkeys })) {
        return MFA_REASONS.mfaRequired
    }
    if (!staffSessionMeets(context.session.sessionInfo?.data.auth, nowUnixMs())) {
        return MFA_REASONS.mfaSessionRequired
    }
    return null
}

/**
 * The HTTP middleware `can:<permission>`: reads the role from the database on every request (a
 * role change applies from the next request) and lets the request through when the role has
 * the permission. Placed after `auth_guard`, which answers 401 for an anonymous request first.
 */
export function permissionGuard(permission: Permission): Middleware {
    return async (context: HttpContext, next: () => Promise<void>): Promise<void> => {
        // feat-271 (Р13): read once by its brand constructor; a session id that is not a row id
        // is refused like an anonymous request, never a 500.
        const userId = parseUserId(context.auth.getUserId())
        if (userId === null) {
            deny(context)
            return
        }
        const role = await userRoleService.findRole(userId)
        if (role === undefined || !roleHasPermission(role, permission)) {
            deny(context)
            return
        }
        // Every role with a permission is a staff role (isStaffRole).
        const refusal = await staffMfaRefusal(context, userId)
        if (refusal !== null) {
            deny(context, refusal)
            return
        }
        // The role for the service checks of this request (Р5) and the audit actor (feat-235).
        rememberActorRole(context, role)
        await next()
    }
}
