import { randomUUID } from 'node:crypto'
import * as uWS from 'uWebSockets.js'
import type { HttpRequest, HttpResponse, WebSocket, TemplatedApp } from 'uWebSockets.js'
import appConfig from '#config/app.js'
import corsConfig from '#config/cors.js'
import state from '#app/state/state.js'
import { createResponseData } from '#vendor/utils/network/response-data.js'
import { hasResponseBody, isEmptyPayload } from '#vendor/utils/network/response-body.js'
import {
    onMessage,
    onOpen,
    onClose,
    handleUpgrade,
    closeAllWs,
} from '#vendor/utils/network/ws-handlers.js'
import {
    getHeaders,
    getData,
    extractParameters,
    normalizePath,
    parseCookies,
    detectBodyKind,
    resolveMaxBodySize,
    type BodyKind,
    type RequestAbortSignal,
} from '../utils/network/http-request-handlers.js'
import { ParameterValidationError } from '#app/validate/checkers/parameter-checker.js'
import { ValidationError } from '#app/validate/errors/validation-error.js'
import { PayloadTooLargeError } from '#vendor/utils/network/errors/payload-too-large-error.js'
import { MalformedBodyError } from '#vendor/utils/network/errors/malformed-body-error.js'
import { RedisUnavailableError } from '#vendor/utils/network/errors/redis-unavailable-error.js'
import { SessionVerificationUnavailableError } from '#vendor/utils/network/errors/session-verification-unavailable-error.js'
import { UnsupportedMediaTypeError } from '#vendor/utils/network/errors/unsupported-media-type-error.js'
import logger from '#vendor/utils/logger.js'
import { isWsChannel, type WsChannel } from 'shared/guards'
import {
    buildStatusErrorBody,
    setHeaders,
    setCookies,
    setSecurityHeaders,
    setApiCacheHeader,
    writeHttpStatus,
} from '#vendor/utils/network/http-response-handlers.js'
import executeMiddlewares from '#vendor/utils/middlewares/core/execute-httpMiddlewares.js'
import checkRateLimit, { checkGlobalRateLimit } from '#vendor/utils/rate-limit/http-rate-limit.js'
import type {
    HttpContext,
    HttpData,
    MyWebSocket,
    NormalizedRouteItem,
    ResponseData,
    RouteItem,
    Payload,
    UploadedFile,
    routeList,
    WsRoutes,
} from '#vendor/types/types.js'
import contextHandler from '../utils/context/http-context.js'
import {
    cacheStaticSource,
    staticHandler,
    staticCacheHandler,
} from '#vendor/start/static-server.js'
import configApp from '#config/app.js'
import getIP from '#vendor/utils/network/get-ip.js'
import { serializeRoutes } from '#vendor/utils/routing/serialize-routes.js'
import { isBodyMethod } from '#vendor/utils/routing/body-methods.js'
import { makeJson } from '#vendor/utils/helpers/json-handlers.js'
import { validateRoutePayload } from '#vendor/utils/validation/validate-route-payload.js'
import { flattenQuery } from '#vendor/utils/validation/flatten-query.js'

export type {
    HttpRequest,
    HttpResponse,
    us_socket_context_t,
    us_listen_socket,
    WebSocket,
    TemplatedApp,
    CompressOptions,
} from 'uWebSockets.js'

export type UserData = Record<string, unknown>
const server: TemplatedApp = uWS.App()

interface ServerRoutes {
    httpRoutes: NormalizedRouteItem[]
    wsRoutesByUrl: Readonly<WsRoutes>
    sourceHttpRoutes: routeList
    sourceWsRoutes: routeList
}

// The type limits callers at compile time; the runtime check covers values that
// bypass it (casts, untyped data), so nothing is published to an arbitrary topic.
// Returns true when the channel is allowed and publish was called; it does not
// confirm delivery (the uWS publish result is ignored). `message` is the serialized
// broadcast JSON, built by broadcastService after the event schema check.
const broadcastToChannel = (channel: WsChannel, event: string, message: string): boolean => {
    if (!isWsChannel(channel)) {
        logger.warn(
            { channel: String(channel).slice(0, 64), event },
            'broadcastToChannel: unknown channel, message dropped',
        )
        return false
    }
    server.publish(channel, message)
    return true
}

const configureWebsockets = (
    server: TemplatedApp,
    wsRoutesByUrl: Readonly<WsRoutes>,
): TemplatedApp => {
    return server.ws(`/${appConfig.pathPrefix}/websocket`, {
        compression: 0,
        idleTimeout: 120, // According to protocol
        maxPayloadLength: 1 * 1024 * 1024,
        maxBackpressure: 64 * 1024,
        open: (ws: WebSocket<Record<string, unknown>>): void => {
            onOpen(ws as MyWebSocket)
        },
        message: (
            ws: WebSocket<Record<string, unknown>>,
            message: ArrayBuffer,
            isBinary: boolean,
        ) => onMessage(ws as MyWebSocket, message, isBinary, wsRoutesByUrl),
        // upgrade: async (res: HttpResponse, req: HttpRequest, context: us_socket_context_t) => {
        //    await handleUpgrade(res, req, context);
        // },
        upgrade: handleUpgrade,
        // drain: (ws) => handleDrain(ws),
        close: (
            ws: WebSocket<Record<string, unknown>>,
            code: number,
            message: ArrayBuffer,
        ): void => {
            onClose(ws as MyWebSocket, code, message).catch((error: unknown) => {
                logger.error({ err: error }, 'WebSocket close handler failed')
            })
        },
    })
}

// getResponseData is now a thin wrapper around the shared response-data builder.
const getResponseData = createResponseData

interface RequestMetadata {
    ip: string
    cookies: Map<string, string>
    query: URLSearchParams
    headers: Map<string, string>
    params: Record<string, string>
    contentType: string | undefined
    bodyKind: BodyKind
    hasBody: boolean
}

// uWS `req` is only valid until the first `await`. Collect everything
// synchronously here so rate-limit (and any other pre-body checks) can run
// against a detached snapshot.
const collectRequestMetadata = (
    req: HttpRequest,
    res: HttpResponse,
    route: RouteItem,
): RequestMetadata => {
    const cookies: Map<string, string> = parseCookies(req.getHeader('cookie'))
    const query = new URLSearchParams(req.getQuery())
    const headers = getHeaders(req)
    const params: Record<string, string> =
        route.parametersKey !== undefined && route.parametersKey.length > 0
            ? extractParameters(route.parametersKey, req)
            : {}
    const contentType = headers.get('content-type')
    const ip = getIP(req, res)
    const hasBody = isBodyMethod(route.method)
    const bodyKind: BodyKind = contentType !== undefined ? detectBodyKind(contentType) : 'other'

    return {
        ip,
        cookies,
        query,
        headers,
        params,
        contentType,
        bodyKind,
        hasBody,
    }
}

/**
 * Validates the query string when the route declares a `queryValidator`.
 * Runs after rate-limit and before body parsing — so middleware and the
 * handler always see either a typed object (validator present) or `null`
 * (validator absent), never a raw `URLSearchParams`.
 */
export const validateQuery = (meta: RequestMetadata, route: RouteItem): unknown => {
    if (route.queryValidator === undefined) {
        return null
    }
    const arrayKeys = new Set<string>(route.queryArrays ?? [])
    const flattened = flattenQuery(meta.query, arrayKeys)
    return validateRoutePayload(route.queryValidator, flattened)
}

const hasBodyFraming = (headers: Map<string, string>): boolean => {
    if (headers.has('transfer-encoding')) return true
    const contentLength = headers.get('content-length')
    // "0", "00", … all mean zero bytes (RFC 9110 §8.6); anything else,
    // including malformed values, is treated as a body.
    return contentLength !== undefined && !/^0+$/.test(contentLength.trim())
}

export const readAndParseBody = async (
    res: HttpResponse,
    meta: RequestMetadata,
    route: RouteItem,
    abortSignal: RequestAbortSignal,
): Promise<{
    payload: Payload | null
    files: Map<string, UploadedFile> | null
}> => {
    if (!meta.hasBody) {
        return { payload: null, files: null }
    }

    const allowed: BodyKind[] = route.allowedContentTypes ?? ['json']

    if (meta.contentType === undefined) {
        if (route.validator === undefined) {
            return { payload: null, files: null }
        }
        // API contract (RFC 9110 §8.3 does not require 415 here): body framing
        // without Content-Type is rejected before reading; no framing means an
        // empty body, validated like empty JSON. Transfer-Encoding counts as
        // framing even if the chunked body turns out empty (RFC 9112 §6.3).
        if (hasBodyFraming(meta.headers)) {
            logger.warn(
                { routeUrl: route.url, routeMethod: route.method, allowed },
                'Request body without Content-Type rejected',
            )
            throw new UnsupportedMediaTypeError(null, allowed)
        }
        return {
            payload: validateRoutePayload(route.validator, {}) as Payload,
            files: null,
        }
    }

    if (!allowed.includes(meta.bodyKind)) {
        logger.warn(
            {
                routeUrl: route.url,
                routeMethod: route.method,
                receivedContentType: meta.contentType,
                allowed,
            },
            'Content-type rejected — add allowedContentTypes to this route if multipart is intentional',
        )
        throw new UnsupportedMediaTypeError(meta.contentType, allowed)
    }

    const limit = resolveMaxBodySize(meta.bodyKind, route.maxBodySize)
    const rawContentLength = meta.headers.get('content-length')
    const declared =
        rawContentLength !== undefined && /^\d+$/.test(rawContentLength)
            ? Number(rawContentLength)
            : null
    if (declared !== null && declared > limit) {
        throw new PayloadTooLargeError(limit, meta.contentType)
    }

    const result = await getData(res, meta.contentType, meta.headers, limit, abortSignal)

    if (route.validator !== undefined && result.payload !== null) {
        return {
            payload: validateRoutePayload(route.validator, result.payload) as Payload,
            files: result.files,
        }
    }

    return { payload: null, files: result.files }
}

const NO_BODY_SKIPPED_HEADERS = ['content-type', 'content-length'] as const

/**
 * Runtime ResponseSchema check of what the handler returned (feat-044 §4.3.1,
 * feat-046 §4.3). Only a response that will carry the handler payload is checked:
 * whatever the status (a /ready 503 included), but not 3xx/204/205 or an empty
 * payload. The check returns what to send; a rejected payload becomes a canonical 500: the handler headers
 * may describe the rejected payload (ETag, Content-Disposition, ...) and are
 * dropped, the cookies stay because the session has already changed.
 */
const checkHandlerResponse = (
    route: NormalizedRouteItem,
    responseData: ResponseData,
    requestId: string,
): void => {
    if (route.responseCheck === null) return
    const { status, payload } = responseData
    if (isEmptyPayload(payload) || !hasResponseBody(status, payload)) return
    const result = route.responseCheck(payload, { route: route.url, transport: 'http', requestId })
    if (result.ok) {
        // The original object, or its copy without keys undeclared in the schema (log mode).
        responseData.payload = result.payload as Payload
        return
    }
    responseData.status = 500
    responseData.headers.length = 0
    responseData.payload = { ...buildStatusErrorBody(500) }
}

const sendResponse = (
    res: HttpResponse,
    responseData: ResponseData,
    requestOrigin: string | undefined,
): void => {
    const { status } = responseData
    // Only null and undefined are "no payload"; false, 0 and "" are JSON data.
    // undefined is outside the Payload type but a handler cast can still yield it.
    const payload = responseData.payload as Payload | undefined
    const emptyPayload = isEmptyPayload(payload)
    const noBody = !hasResponseBody(status, payload)
    // 200 with nothing to send becomes 204; another 2xx (201, 202, …) keeps its meaning.
    const sentStatus = status === 200 && emptyPayload ? 204 : status
    writeHttpStatus(res, sentStatus)
    if (!noBody) res.writeHeader('content-type', 'application/json')
    setSecurityHeaders(res, responseData.headers)
    setApiCacheHeader(res, responseData.headers)
    // A response without a body has no controller-set Content-Type or
    // Content-Length: uWS frames it itself (res.end writes Content-Length: 0,
    // endWithoutBody writes none, as 204 requires).
    if (responseData.headers.length > 0)
        setHeaders(res, responseData.headers, noBody ? NO_BODY_SKIPPED_HEADERS : undefined)
    if (responseData.cookies.size > 0) setCookies(res, responseData.cookies)
    if (corsConfig.enabled) setCorsHeader(res, requestOrigin)
    if (sentStatus === 204 || sentStatus === 304) {
        // res.end() would add Content-Length: 0, which 204 must not carry
        // (RFC 9110 §8.6) and which would misstate the representation in a 304.
        res.endWithoutBody()
    } else if (noBody) {
        res.end()
    } else if (emptyPayload) {
        res.end(makeJson(buildStatusErrorBody(status)))
    } else res.end(makeJson(payload))
}

interface CanonicalErrorBody {
    status: 'error'
    code: string
    message: string
    details?: unknown
    reason?: string
}

const sendErrorResponse = (
    res: HttpResponse,
    status: number,
    body: CanonicalErrorBody,
    headers: Readonly<Record<string, string>> = {},
): void => {
    res.cork(() => {
        writeHttpStatus(res, status)
        setSecurityHeaders(res)
        setApiCacheHeader(res)
        for (const [name, value] of Object.entries(headers)) {
            res.writeHeader(name, value)
        }
        res.writeHeader('content-type', 'application/json')
        res.end(makeJson(body))
    })
}

// interface State {
//   listenSocket: us_listen_socket | null;
// }

interface HttpSentryContext {
    requestId?: string | undefined
    userId?: string | undefined
    route?: string | undefined
    method?: string | undefined
}

const definedFields = (context: HttpSentryContext): Record<string, string> =>
    Object.fromEntries(
        Object.entries(context).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
        ),
    )

export const handleError = (
    res: HttpResponse,
    error: unknown,
    sentryContext?: HttpSentryContext,
): void => {
    // The request's own logger: every record below carries requestId (and userId
    // when known), including 413/415/422 thrown before the handler context exists.
    const log = logger.child(definedFields(sentryContext ?? {}))
    if (error instanceof PayloadTooLargeError) {
        log.warn({ limit: error.limit, contentType: error.contentType }, 'Payload too large')
        sendErrorResponse(res, error.statusCode, {
            status: 'error',
            code: error.code,
            message: 'Payload too large',
            details: {
                kind: 'payload_too_large',
                limit: error.limit,
                contentType: error.contentType,
            },
        })
    } else if (error instanceof RedisUnavailableError) {
        // Still error level for stdout; the Sentry transport skips this type
        // (redis-health reports one event per incident). No ioredis text in the body.
        log.error({ err: error }, 'Request failed: Redis unavailable')
        sendErrorResponse(
            res,
            error.statusCode,
            {
                status: 'error',
                code: error.code,
                message: 'Service temporarily unavailable. Try again later.',
            },
            { 'Retry-After': '1' },
        )
    } else if (error instanceof SessionVerificationUnavailableError) {
        // Fail-closed: no sessionToken answer, no access. No driver text in the body.
        log.error({ err: error }, 'Request failed: session verification unavailable')
        sendErrorResponse(
            res,
            error.statusCode,
            {
                status: 'error',
                code: error.code,
                message: 'Service temporarily unavailable. Try again later.',
            },
            { 'Retry-After': '1' },
        )
    } else if (error instanceof MalformedBodyError) {
        // A client error: warn without the body, keep it out of Sentry.
        log.warn({ bodyKind: error.bodyKind }, 'Malformed request body')
        sendErrorResponse(res, error.statusCode, {
            status: 'error',
            code: error.code,
            message: error.message,
        })
    } else if (error instanceof UnsupportedMediaTypeError) {
        log.warn(
            {
                receivedContentType: error.receivedContentType,
                allowedKinds: error.allowedKinds,
            },
            'Unsupported media type',
        )
        sendErrorResponse(res, error.statusCode, {
            status: 'error',
            code: error.code,
            message: 'Unsupported Media Type',
            details: {
                kind: 'unsupported_media_type',
                receivedContentType: error.receivedContentType,
                allowedKinds: error.allowedKinds,
            },
        })
    } else if (error instanceof ValidationError) {
        log.warn({ err: error }, 'Handle Error')
        sendErrorResponse(res, error.statusCode, {
            status: 'error',
            code: error.code,
            message: 'Validation failure',
            details: {
                kind: 'validation',
                messages: error.messages,
                ...(error.issues !== undefined ? { issues: error.issues } : {}),
            },
        })
    } else if (error instanceof ParameterValidationError) {
        log.warn({ err: error }, 'Handle Error')
        sendErrorResponse(res, error.statusCode, {
            status: 'error',
            code: error.code,
            message: 'Invalid parameter',
            details: {
                kind: 'parameter_validation',
                parameter: error.parameterName,
                messages: [error.message],
            },
        })
    } else {
        log.error({ err: error }, 'Handle Error')
        const errorMessage = configApp.env === 'local' ? String(error) : 'Internal server error'
        sendErrorResponse(res, 500, {
            status: 'error',
            code: 'internal_error',
            message: errorMessage,
        })
    }
}

const docRoutesHandler = async (
    res: HttpResponse,
    req: HttpRequest,
    routes: ServerRoutes,
): Promise<void> => {
    return new Promise((resolve: () => void) => {
        if (
            state['listenSocket'] !== undefined &&
            configApp.env === 'manual-test' &&
            configApp.docPage &&
            configApp.serveStatic
        ) {
            try {
                const serializedHttpRoutes = serializeRoutes(routes.sourceHttpRoutes)
                const serializedWsRoutes = serializeRoutes(routes.sourceWsRoutes)

                res.cork(() => {
                    writeHttpStatus(res, 200)
                    setSecurityHeaders(res)
                    res.writeHeader('content-type', 'application/json')
                    res.end(
                        makeJson({
                            httpRoutes: serializedHttpRoutes,
                            wsRoutes: serializedWsRoutes,
                            pathPrefix: appConfig.pathPrefix,
                        }),
                    )
                })
            } catch (err: unknown) {
                res.cork(() => {
                    handleError(res, err, {
                        route: req.getUrl(),
                        method: req.getMethod(),
                    })
                })
            }
        } else {
            sendErrorResponse(res, 404, {
                status: 'error',
                code: 'not_found',
                message: 'Not found',
            })
        }
        resolve()
    })
}

const setHttpHandler = async (
    res: HttpResponse,
    req: HttpRequest,
    route: NormalizedRouteItem,
): Promise<void> => {
    if (state['listenSocket'] === undefined) {
        logger.warn('We just refuse if already shutting down')
        res.close()
        return
    }

    // Single onAborted registration — uWS res.onAborted() is a single slot,
    // re-registering replaces the previous handler. We wire readData via
    // RequestAbortSignal instead of calling res.onAborted() a second time.
    const abortSignal: RequestAbortSignal = { aborted: false }
    // Standard signal for handlers (e.g. to cancel an AI call when the client leaves).
    const requestAbort = new AbortController()
    res.onAborted(() => {
        abortSignal.aborted = true
        abortSignal.onAbort?.()
        requestAbort.abort()
    })
    const responseData = getResponseData()
    let origin: string | undefined
    // From the first step, so errors before the handler (413/415/422) are traceable.
    const requestId = randomUUID()
    // Read when the error happens: the session middleware sets the user later.
    let context: HttpContext | undefined

    try {
        // Step 1: snapshot req synchronously — it is only valid until the first await.
        const meta = collectRequestMetadata(req, res, route)
        origin = meta.headers.get('origin')

        // Step 2: rate-limit BEFORE reading body. Otherwise an attacker can make
        // the server buffer and parse up to maxOctetStreamBodySize even on blocked
        // routes, which is a DoS vector.
        //
        // Sync by design: если здесь будет `await`, uWS может доставить тело
        // маленьких POST-запросов до того, как readData зарегистрирует
        // res.onData(), и хендлер навсегда зависнет в pending.
        // L1 (per IP, all API requests) first, then the stricter per-route limit.
        const rateLimitPassed =
            checkGlobalRateLimit(meta.ip, responseData) &&
            checkRateLimit(meta.ip, responseData, route, route.groupRateLimit)

        if (!rateLimitPassed) {
            if (abortSignal.aborted) return
            res.cork(() => {
                sendResponse(res, responseData, origin)
            })
            return
        }

        // Step 3: validate query. Done before body so we don't waste IO/parse
        // budget on an already-invalid query, and so middleware sees a typed
        // object on routes with a queryValidator. When the route has no
        // queryValidator, this returns null — handlers must opt in to query
        // by declaring a schema.
        const validatedQuery = validateQuery(meta, route)

        // Step 4: now that the client is not rate-limited and the query is
        // validated, read and parse the body.
        const { payload, files } = await readAndParseBody(res, meta, route, abortSignal)

        // Step 5: middleware chain + handler.
        const httpData: HttpData = {
            method: route.method,
            ip: meta.ip,
            params: meta.params,
            payload,
            query: validatedQuery as HttpData['query'],
            headers: meta.headers,
            contentType: meta.contentType,
            cookies: meta.cookies,
            isJson: meta.hasBody && meta.bodyKind === 'json',
            files,
            hasFile: (name: string): boolean => files?.has(name) ?? false,
        }
        context = contextHandler(httpData, responseData, requestAbort.signal, requestId)

        if (
            (route.middlewares?.length === 0 ||
                (await executeMiddlewares(route.middlewares, context))) &&
            responseData.status >= 200 &&
            responseData.status < 300
        ) {
            responseData.payload = await route.handler(context)
            checkHandlerResponse(route, responseData, requestId)
        }

        // After the handler, right before sending: a slow request must not restore
        // the cookie of a session that another request replaced meanwhile.
        await context.session.beforeSend?.()

        if (abortSignal.aborted) return

        res.cork(() => {
            sendResponse(res, responseData, origin)
        })
    } catch (err: unknown) {
        if (abortSignal.aborted) return
        res.cork(() => {
            handleError(res, err, {
                requestId,
                userId: context?.auth.getUserId() ?? undefined,
                route: route.url,
                method: route.method,
            })
        })
    }
}

const configureHttp = async (server: TemplatedApp, routes: ServerRoutes): Promise<void> => {
    if (appConfig.serveStatic) {
        const staticCache = await cacheStaticSource()
        if (staticCache !== null) {
            staticCache.forEach((value, key) => {
                server.get(key, async (res, req) => {
                    await staticCacheHandler(res, req, value)
                })
            })
        }
    }

    routes.httpRoutes.forEach((route: NormalizedRouteItem) => {
        registerHttpRoute(server, route)
    })
    if (configApp.env === 'manual-test' && configApp.docPage && configApp.serveStatic) {
        server.get(`/${appConfig.pathPrefix}/doc/routes`, async (res, req) => {
            // An API path like any other: it spends the same L1 budget.
            const responseData = createResponseData()
            if (!checkGlobalRateLimit(getIP(req, res), responseData)) {
                const origin = req.getHeader('origin')
                res.cork(() => {
                    sendResponse(res, responseData, origin)
                })
                return
            }
            await docRoutesHandler(res, req, routes)
        })
    }

    server.any('/*', (res: HttpResponse, req: HttpRequest): void => {
        const url = req.getUrl()
        const method = req.getMethod()
        const origin = req.getHeader('origin')
        const isApiPath = url.startsWith(`/${appConfig.pathPrefix}/`)
        // Unmatched API requests (404, preflight, plain HTTP on the WebSocket path) share
        // the L1 budget. Real upgrades never get here: handleUpgrade has its own budget.
        if (isApiPath) {
            const responseData = createResponseData()
            if (!checkGlobalRateLimit(getIP(req, res), responseData)) {
                res.cork(() => {
                    sendResponse(res, responseData, origin)
                })
                return
            }
        }
        if (corsConfig.enabled && method === 'options') {
            //'OPTIONS' method === 'OPTIONS'
            res.cork(() => {
                writeHttpStatus(res, 200)
                setSecurityHeaders(res)
                setCorsHeader(res, origin)
                res.end()
            })
        } else if (isApiPath && method !== 'options') {
            sendErrorResponse(res, 404, {
                status: 'error',
                code: 'not_found',
                message: 'Route not found',
            })
        } else if (appConfig.serveStatic && method === 'get') {
            void staticHandler(res, req).catch((err: unknown) => {
                const error = err instanceof Error ? err : new Error(String(err))
                logger.error({ err: error, url }, 'Unhandled static handler error')
            })
        } else {
            sendErrorResponse(res, 404, {
                status: 'error',
                code: 'not_found',
                message: 'Not found',
            })
        }
    })
}

const registerHttpRoute = (server: TemplatedApp, route: NormalizedRouteItem): void => {
    const path = `/${normalizePath(route.url)}`
    const handler = async (res: HttpResponse, req: HttpRequest): Promise<void> => {
        await setHttpHandler(res, req, route)
    }

    switch (route.method) {
        case 'get':
            server.get(path, handler)
            return
        case 'post':
            server.post(path, handler)
            return
        case 'put':
            server.put(path, handler)
            return
        case 'patch':
            server.patch(path, handler)
            return
        case 'del':
            server.del(path, handler)
            return
        case 'delete':
        case 'options':
        case 'ws':
            throw new Error(`Unsupported HTTP route method: ${route.method}`)
    }
}

const resolveAllowedOrigin = (requestOrigin: string | undefined): string | null => {
    if (requestOrigin === undefined || requestOrigin === '') return null
    return corsConfig.allowedOrigins.includes(requestOrigin) ? requestOrigin : null
}

const setCorsHeader = (res: HttpResponse, requestOrigin: string | undefined): void => {
    // Vary: Origin prevents intermediate caches from serving a CORS response
    // to an origin other than the one it was computed for.
    res.writeHeader('Vary', 'Origin')
    const allowed = resolveAllowedOrigin(requestOrigin)
    if (allowed === null) return
    res.writeHeader('Access-Control-Allow-Origin', allowed)
    res.writeHeader('Access-Control-Allow-Methods', corsConfig.methods)
    res.writeHeader('Access-Control-Max-Age', String(corsConfig.maxAge))
    res.writeHeader('Access-Control-Expose-Headers', corsConfig.exposeHeaders)
    res.writeHeader('Access-Control-Allow-Headers', corsConfig.allowHeaders)
    if (corsConfig.credentials) {
        res.writeHeader('Access-Control-Allow-Credentials', 'true')
    }
}
// let server = null;
const initServer = async (routes: ServerRoutes): Promise<void> => {
    configureWebsockets(server, routes.wsRoutesByUrl)
    await configureHttp(server, routes)
    if (appConfig.unixPath !== undefined) {
        server.listen_unix((token) => {
            logger.info(`Listening unix socket: ${appConfig.unixPath ?? ''}`)
            state['listenSocket'] = token
        }, appConfig.unixPath)
    } else {
        server.listen(appConfig.host, appConfig.port, (token) => {
            if (token !== false) {
                logger.info(`Listening http://${appConfig.host}:${String(appConfig.port)}`)
                state['listenSocket'] = token
            } else {
                logger.error(`Failed to listen to port ${String(appConfig.port)}`)
            }
        })
    }
}

const stopServer = async (type = 'handle'): Promise<void> => {
    logger.info(`server stop type: ${type}`)
    try {
        await closeAllWs()
        if (state['listenSocket'] !== undefined) {
            uWS.us_listen_socket_close(state['listenSocket'] as uWS.us_listen_socket)
        }
        state['listenSocket'] = undefined
    } catch (error) {
        logger.error({ err: error }, 'Server stop failed')
    }
}

export { initServer, stopServer, broadcastToChannel }
