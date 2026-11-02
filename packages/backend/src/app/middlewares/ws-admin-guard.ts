import type { HttpContext, WsContext } from '#vendor/types/types.js'
import { forbidden } from '#app/services/shared/errors.js'
import { appErrorToPayload } from '#app/services/shared/app-error-payload.js'

// WS counterpart of admin_guard: the WS dispatcher runs route middlewares with a
// WsContext (no auth, no HTTP responseData), so the role comes from the
// connection's userData. Denied requests get the same 403 response the admin WS
// controller returned before the guard existed.
const wsAdminGuard = async (context: HttpContext, next: () => Promise<void>): Promise<void> => {
    const wsContext = context as unknown as WsContext
    if (wsContext.userData?.role !== 'admin') {
        wsContext.responseData.status = '403'
        wsContext.responseData.data = appErrorToPayload(forbidden('Access denied'))
        return
    }
    await next()
}

export default wsAdminGuard
