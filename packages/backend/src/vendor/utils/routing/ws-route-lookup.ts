import type { WsRoutes } from '#vendor/types/types.js'

/**
 * The route of a WebSocket event (`<route>:<suffix>`), or undefined. Own properties only: a
 * map built as a plain object would answer `constructor` with Object itself (feat-149).
 */
export const findWsRoute = (
    wsRoutesByUrl: Readonly<WsRoutes>,
    event: string,
): WsRoutes[string] | undefined => {
    const nameRoute = event.split(':')[0]
    if (nameRoute === undefined) return undefined
    return Object.hasOwn(wsRoutesByUrl, nameRoute) ? wsRoutesByUrl[nameRoute] : undefined
}
