import { roleHasPermission, type Permission } from 'shared/access'
import { MFA_REASONS } from 'shared/mfa'

import type { Middleware, WsContext } from '#vendor/types/types.js'
import { forbidden } from '#app/services/shared/errors.js'
import { mapWsControllerError } from '#app/controllers/shared/controller-error.js'
import { staffSessionMeets } from '#app/services/auth/mfa/staff-policy.js'

/**
 * The WS middleware `ws_can:<permission>` (feat-240, Р4). The role is the one of the connection
 * (`userData.role`), kept in step with the database by wsRoleSync (Р8). While the admin channel
 * of the connection is paused after a failed role read, nothing that needs a permission passes.
 * feat-247 (Р11): nor while the session of the connection does not meet the staff MFA rule.
 */
export function wsPermissionGuard(permission: Permission): Middleware<WsContext> {
    return async (context: WsContext, next: () => Promise<void>): Promise<void> => {
        const userData = context.userData
        if (
            userData === null ||
            userData.adminChannelPaused === true ||
            !roleHasPermission(userData.role, permission)
        ) {
            context.responseData.data = mapWsControllerError(context, forbidden('Access denied'))
            return
        }
        // feat-247 (Р11): a staff permission needs a session that meets the staff MFA rule, checked
        // with the current time on every message (always met while the rule is off).
        if (!staffSessionMeets(userData.auth, Date.now())) {
            context.responseData.data = mapWsControllerError(
                context,
                forbidden('Access denied', MFA_REASONS.mfaSessionRequired),
            )
            return
        }
        await next()
    }
}
