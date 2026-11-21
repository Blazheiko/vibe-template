import { roleHasPermission, type Permission } from 'shared/access'

import type { HttpContext, Middleware } from '#vendor/types/types.js'
import { userRoleService } from '#app/services/user/user-role-service.js'
import { forbidden } from '#app/services/shared/errors.js'
import { appErrorToPayload } from '#app/services/shared/app-error-payload.js'
import { applyAppErrorStatus } from '#app/services/shared/apply-service-status.js'
import { rememberActorRole } from '#app/controllers/shared/audit-actor.js'

// feat-240 (Р4): the canonical 403 body, the same for every permission, so a refusal never says
// which permission was missing.
function deny(context: HttpContext): void {
    const error = forbidden('Access denied')
    applyAppErrorStatus(context.responseData, error)
    context.responseData.payload = appErrorToPayload(error)
}

/**
 * The HTTP middleware `can:<permission>`: reads the role from the database on every request (a
 * role change applies from the next request) and lets the request through when the role has
 * the permission. Placed after `auth_guard`, which answers 401 for an anonymous request first.
 */
export function permissionGuard(permission: Permission): Middleware {
    return async (context: HttpContext, next: () => Promise<void>): Promise<void> => {
        const userId = context.auth.getUserId()
        if (userId === null) {
            deny(context)
            return
        }
        const role = await userRoleService.findRole(BigInt(userId))
        if (role === undefined || !roleHasPermission(role, permission)) {
            deny(context)
            return
        }
        // The role for the service checks of this request (Р5) and the audit actor (feat-235).
        rememberActorRole(context, role)
        await next()
    }
}
