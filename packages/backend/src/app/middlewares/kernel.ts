import sessionWeb from '#vendor/utils/middlewares/ws/session-web.js'
import authGuard from '#vendor/utils/middlewares/core/auth-guard.js'
import adminGuard from '#app/middlewares/admin-guard.js'
import csrfGuard from '#app/middlewares/csrf-guard.js'
import wsAdminGuard from '#app/middlewares/ws-admin-guard.js'
import type { Middleware, WsContext } from '#vendor/types/types.js'

// Two maps, one per transport: a middleware gets the context type it was written for.
// A route naming a middleware of the other transport fails like an unknown name.
export const httpMiddlewares: Readonly<Record<string, Middleware>> = {
    session_web: sessionWeb,
    csrf_guard: csrfGuard,
    auth_guard: authGuard,
    admin_guard: adminGuard,
}

export const wsMiddlewares: Readonly<Record<string, Middleware<WsContext>>> = {
    ws_admin_guard: wsAdminGuard,
}
