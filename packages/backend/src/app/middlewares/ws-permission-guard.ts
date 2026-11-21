import { roleHasPermission, type Permission } from 'shared/access'

import type { Middleware, WsContext } from '#vendor/types/types.js'
import { forbidden } from '#app/services/shared/errors.js'
import { mapWsControllerError } from '#app/controllers/shared/controller-error.js'

/**
 * The WS middleware `ws_can:<permission>` (feat-240, Р4). The role is the one of the connection
 * (`userData.role`), kept in step with the database by wsRoleSync (Р8). While the admin channel
 * of the connection is paused after a failed role read, nothing that needs a permission passes.
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
        await next()
    }
}
