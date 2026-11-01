import sessionWeb from '#vendor/utils/middlewares/ws/session-web.js'
import sessionAPI from '#vendor/utils/middlewares/http/session-api.js'
import authGuard from '#vendor/utils/middlewares/core/auth-guard.js'
import adminGuard from '#app/middlewares/admin-guard.js'
import csrfGuard from '#app/middlewares/csrf-guard.js'
import wsAdminGuard from '#app/middlewares/ws-admin-guard.js'
import type { Middleware } from '#vendor/types/types.js'

const middlewares: Record<string, Middleware> = {
    session_web: sessionWeb,
    session_api: sessionAPI,
    csrf_guard: csrfGuard,
    auth_guard: authGuard,
    admin_guard: adminGuard,
    ws_admin_guard: wsAdminGuard,
}
export default middlewares
