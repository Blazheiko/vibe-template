import type { HttpContext, Middleware } from '#vendor/types/types.js'
import { userRoleService } from '#app/services/user/user-role-service.js'
import { forbidden } from '#app/services/shared/errors.js'
import { appErrorToPayload } from '#app/services/shared/app-error-payload.js'
import { applyAppErrorStatus } from '#app/services/shared/apply-service-status.js'
import { rememberActorRole } from '#app/controllers/shared/audit-actor.js'

// The canonical error body ({ status: 'error', code: 'forbidden' }), the same as every other 403.
function deny(context: HttpContext): void {
    const error = forbidden('Admin access required')
    applyAppErrorStatus(context.responseData, error)
    context.responseData.payload = appErrorToPayload(error)
}

const adminGuard: Middleware = async (
    context: HttpContext,
    next: () => Promise<void>,
): Promise<void> => {
    const userId = context.auth.getUserId()
    if (userId === null) {
        deny(context)
        return
    }
    const role = await userRoleService.findRole(BigInt(userId))
    if (role !== 'admin') {
        deny(context)
        return
    }
    // feat-235: the actor of an audited admin change takes its role from this read.
    rememberActorRole(context, role)
    await next()
}

export default adminGuard
