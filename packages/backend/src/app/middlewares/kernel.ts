import { PERMISSIONS, type Permission } from 'shared/access'

import sessionWeb from '#vendor/utils/middlewares/ws/session-web.js'
import authGuard from '#vendor/utils/middlewares/core/auth-guard.js'
import csrfGuard from '#app/middlewares/csrf-guard.js'
import { permissionGuard } from '#app/middlewares/permission-guard.js'
import { wsPermissionGuard } from '#app/middlewares/ws-permission-guard.js'
import type { Middleware, WsContext } from '#vendor/types/types.js'

// feat-240 (Р4): one `can:<permission>` (HTTP) and one `ws_can:<permission>` (WS) per permission
// of the catalog in shared/access; a route names the permission it needs.
const byPermission = <TContext>(
    prefix: string,
    guard: (permission: Permission) => Middleware<TContext>,
): Record<string, Middleware<TContext>> =>
    Object.fromEntries(
        PERMISSIONS.map((permission) => [`${prefix}${permission}`, guard(permission)]),
    )

// Two maps, one per transport: a middleware gets the context type it was written for.
// A route naming a middleware of the other transport fails like an unknown name.
export const httpMiddlewares: Readonly<Record<string, Middleware>> = {
    session_web: sessionWeb,
    csrf_guard: csrfGuard,
    auth_guard: authGuard,
    ...byPermission('can:', permissionGuard),
}

export const wsMiddlewares: Readonly<Record<string, Middleware<WsContext>>> = {
    ...byPermission('ws_can:', wsPermissionGuard),
}
