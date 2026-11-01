import logger from '#vendor/utils/logger.js'
import { normalizePath } from '#vendor/utils/network/http-request-handlers.js'
import { isNoBodyMethod } from '#vendor/utils/routing/body-methods.js'
import appConfig from '#config/app.js'
import responseValidationConfig from '#config/response-validation.js'
import { createResponseCheck } from '#vendor/utils/validation/validate-response.js'
import type {
    Method,
    NormalizedRouteItem,
    RateLimit,
    RouteItem,
    WsRoutes,
    routeList,
} from '#vendor/types/types.js'

const parseRouteParams = (url: string): string[] =>
    url
        .split('/')
        .filter((segment) => segment.startsWith(':'))
        .map((segment) => segment.slice(1))

const createRoute = (
    method: Method,
    route: RouteItem,
    groupRateLimit: RateLimit | undefined,
): NormalizedRouteItem => {
    const responseSchema = route.ResponseSchema
    const normalizedUrl = normalizePath(route.url)

    return {
        method,
        url: `${appConfig.pathPrefix}/${normalizedUrl}`,
        handler: route.handler,
        middlewares: route.middlewares ?? [],
        validator: route.validator ?? undefined,
        queryValidator: route.queryValidator ?? undefined,
        queryAllowExtra: route.queryAllowExtra ?? undefined,
        queryArrays: route.queryArrays ?? undefined,
        rateLimit: route.rateLimit ?? groupRateLimit,
        groupRateLimit: groupRateLimit ?? undefined,
        parametersKey: parseRouteParams(normalizedUrl),
        description: route.description,
        allowedContentTypes: route.allowedContentTypes,
        maxBodySize: route.maxBodySize,
        ...(responseSchema !== undefined ? { ResponseSchema: responseSchema } : {}),
        // Built once here; null only for a route without a ResponseSchema.
        responseCheck: createResponseCheck(responseSchema, responseValidationConfig),
    }
}

const routeHandler = (route: RouteItem, groupRateLimit?: RateLimit): NormalizedRouteItem => {
    let method = route.method
    method = method === 'delete' ? 'del' : route.method
    if (isNoBodyMethod(method) && route.validator !== undefined) {
        throw new Error(
            `Route ${route.method.toUpperCase()} ${route.url} declares a body validator, ` +
                `but ${route.method.toUpperCase()} requests never read a body. ` +
                'Pass the data via :params or queryValidator, or use post/put/patch.',
        )
    }
    if (route.maxBodySize !== undefined) {
        if (isNoBodyMethod(method)) {
            throw new Error(
                `Route ${route.method.toUpperCase()} ${route.url} sets maxBodySize, ` +
                    `but ${route.method.toUpperCase()} requests never read a body.`,
            )
        }
        if (!Number.isSafeInteger(route.maxBodySize) || route.maxBodySize <= 0) {
            throw new Error(
                `Route ${route.method.toUpperCase()} ${route.url}: maxBodySize must be a positive integer (bytes), got ${String(route.maxBodySize)}.`,
            )
        }
    }
    return createRoute(method, route, groupRateLimit)
}

const routesHandler = (routeList: routeList): NormalizedRouteItem[] => {
    logger.info('routes Handler start')
    const parseRouteList = parseGroups(routeList, '', [], undefined)
    return parseRouteList.map((route) => routeHandler(route, route.groupRateLimit))
}

const parseGroups = (
    routeList: routeList,
    prefix: string,
    middlewares: string[],
    groupRateLimit: RateLimit | undefined,
): RouteItem[] => {
    const parseRouteList: RouteItem[] = []
    routeList.forEach((route) => {
        if ('group' in route && Array.isArray(route.group) && route.group.length > 0) {
            const prefixInitial = normalizePath(prefix)
            const prefixGroup = normalizePath(route.prefix)
            const middlewaresGroup =
                route.middlewares !== undefined &&
                Array.isArray(route.middlewares) &&
                route.middlewares.length > 0
                    ? middlewares.concat(route.middlewares)
                    : middlewares
            // Group limits are passed to subgroups
            const currentGroupRateLimit = route.rateLimit ?? groupRateLimit
            const routeGroup = parseGroups(
                route.group,
                `${prefixInitial}/${prefixGroup}`,
                middlewaresGroup,
                currentGroupRateLimit,
            )
            routeGroup.forEach((item) => {
                parseRouteList.push(item)
            })
        } else if ('url' in route && 'handler' in route) {
            const routeUrl = prefix !== '' ? `${prefix}/${normalizePath(route.url)}` : route.url
            const routeMiddlewares =
                middlewares.length > 0
                    ? middlewares.concat(route.middlewares ?? [])
                    : route.middlewares

            parseRouteList.push({
                ...route,
                url: routeUrl,
                middlewares: routeMiddlewares,
                groupRateLimit,
            })
        }
    })
    return parseRouteList
}

// Convert flat routes into the full-url lookup used by the WS dispatcher.
// WS dispatch is exact-match only; `:param` route matching is not supported.
const createWsRoutesByUrl = (routes: NormalizedRouteItem[]): WsRoutes => {
    const routesByUrl: WsRoutes = {}
    routes.forEach((route) => {
        if (routesByUrl[route.url] !== undefined) {
            logger.warn({ url: route.url }, 'Duplicate WS route URL')
        }
        routesByUrl[route.url] = route
    })
    return routesByUrl
}

export { createWsRoutesByUrl, routesHandler }
