import type { WsContext } from '#vendor/types/types.js'
import { forbidden } from '#app/services/shared/errors.js'
import { mapWsControllerError } from '#app/controllers/shared/controller-error.js'

// WS counterpart of admin_guard: the role comes from the connection's userData (a
// WsContext has no auth). Denied requests get the same 403 the admin WS controller
// returned before the guard existed.
const wsAdminGuard = async (context: WsContext, next: () => Promise<void>): Promise<void> => {
    if (context.userData?.role !== 'admin') {
        context.responseData.data = mapWsControllerError(context, forbidden('Access denied'))
        return
    }
    await next()
}

export default wsAdminGuard
