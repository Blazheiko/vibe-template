import { randomUUID } from 'node:crypto'
import * as uWS from 'uWebSockets.js'
import type { HttpRequest, HttpResponse, WebSocket, TemplatedApp } from 'uWebSockets.js'
import appConfig from '#config/app.js'
import corsConfig from '#config/cors.js'
import sessionConfig from '#config/session.js'
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
    parseCookies,
    detectBodyKind,
    resolveMaxBodySize,
    type BodyKind,
    type RequestAbortSignal,
} from '../utils/network/http-request-handlers.js'
import { normalizePath } from '#vendor/utils/helpers/normalize-path.js'
import { PayloadTooLargeError } from '#vendor/utils/network/errors/payload-too-large-error.js'
import { UnsupportedMediaTypeError } from '#vendor/utils/network/errors/unsupported-media-type-error.js'
import {
    classifiedErrorBody,
    classifyError,
    logClassifiedError,
} from '#vendor/utils/network/errors/classify-error.js'
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
import { clientKey } from '#vendor/utils/rate-limit/rate-limit-store.js'
import type {
    Cookie,
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
        upgrade: handleUpgrade,
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

    const result = await getData(
        res,
        meta.contentType,
        meta.headers,
        limit,
        abortSignal,
        clientKey(meta.ip),
    )

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

/** What the request already decided about the response before it failed. */
interface ErrorResponseExtras {
    /** Set by the session layer or the handler; the session may already have changed. */
    cookies?: ReadonlyMap<string, Cookie> | undefined
    /** Request Origin, for the CORS headers a browser needs to read the error. */
    origin?: string | undefined
    /** Close the connection with the answer: the rest of the request body is not read. */
    closeConnection?: boolean | undefined
}

const sendErrorResponse = (
    res: HttpResponse,
    status: number,
    body: CanonicalErrorBody,
    headers: Readonly<Record<string, string>> = {},
    extras: ErrorResponseExtras = {},
): void => {
    res.cork(() => {
        writeHttpStatus(res, status)
        setSecurityHeaders(res)
        setApiCacheHeader(res)
        for (const [name, value] of Object.entries(headers)) {
            res.writeHeader(name, value)
        }
        if (extras.cookies !== undefined && extras.cookies.size > 0) {
            setCookies(res, extras.cookies)
        }
        if (corsConfig.enabled) setCorsHeader(res, extras.origin)
        res.writeHeader('content-type', 'application/json')
        // uWS adds `Connection: close` itself and closes the socket once the answer is out.
        if (extras.closeConnection === true) res.end(makeJson(body), true)
        else res.end(makeJson(body))
    })
}

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
    extras?: ErrorResponseExtras,
): void => {
    // The request's own logger: every record carries requestId (and userId when
    // known), including 413/415/422 thrown before the handler context exists.
    const classified = classifyError(error, { exposeInternalMessage: appConfig.env === 'local' })
    logClassifiedError(logger.child(definedFields(sentryContext ?? {})), classified)
    sendErrorResponse(
        res,
        classified.status,
        { status: 'error', ...classifiedErrorBody(classified) },
        classified.headers,
        classified.closeConnection === true ? { ...extras, closeConnection: true } : extras,
    )
}

const docRoutesHandler = (res: HttpResponse, req: HttpRequest, routes: ServerRoutes): void => {
    if (
        state['listenSocket'] !== undefined &&
        appConfig.env === 'manual-test' &&
        appConfig.docPage &&
        appConfig.serveStatic
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
    const responseData = createResponseData()
    // From the first step, so errors before the handler (413/415/422) are traceable.
    const requestId = randomUUID()
    // Read when the error happens: the session middleware sets the user later.
    let context: HttpContext | undefined

    // Before the metadata: collecting it validates the path parameters and can throw, and
    // that 400 still needs the CORS headers for a cross-origin client to read it.
    // An empty value (no header) is the same as no origin for the CORS check.
    const origin = req.getHeader('origin')

    try {
        // Step 1: snapshot req synchronously — it is only valid until the first await.
        const meta = collectRequestMetadata(req, res, route)

        // Step 2: rate-limit BEFORE reading body. Otherwise an attacker can make
        // the server buffer and parse up to maxOctetStreamBodySize even on blocked
        // routes, which is a DoS vector.
        //
        // Sync by design: with an `await` here, uWS can deliver the body of a small
        // POST before readData registers res.onData(), and the handler would hang
        // pending forever.
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
        // A thrown error answers like a returned one: the cookies the session layer set
        // (a login that swapped the session) still reach the client, after the same
        // beforeSend check, so the client is not left with a deleted session's cookie.
        await runBeforeSendQuietly(context, requestId)
        if (abortSignal.aborted) return
        res.cork(() => {
            handleError(
                res,
                err,
                {
                    requestId,
                    userId: context?.auth.getUserId() ?? undefined,
                    route: route.url,
                    method: route.method,
                },
                { cookies: sessionCookieOnly(responseData.cookies), origin },
            )
        })
    }
}

/**
 * The cookies a thrown error still sends: the session cookie only. The session may already
 * have changed in this request (a login, a logout), and the client must get its current
 * cookie. Any other cookie a handler set before the throw belongs to a result that did not
 * happen and is dropped, like the handler's headers.
 */
const sessionCookieOnly = (cookies: ReadonlyMap<string, Cookie>): ReadonlyMap<string, Cookie> => {
    const session = cookies.get(sessionConfig.cookieName)
    return session === undefined ? new Map() : new Map([[sessionConfig.cookieName, session]])
}

// beforeSend may itself fail (Redis down); the error answer must still go out, so its
// failure is logged and the cookie it could not confirm is held back.
const runBeforeSendQuietly = async (
    context: HttpContext | undefined,
    requestId: string,
): Promise<void> => {
    const beforeSend = context?.session.beforeSend
    if (beforeSend === undefined) return
    try {
        await beforeSend()
    } catch (err: unknown) {
        context?.responseData.cookies.clear()
        logger.warn({ err, requestId }, 'beforeSend failed on the error path; cookies dropped')
    }
}

const configureHttp = async (server: TemplatedApp, routes: ServerRoutes): Promise<void> => {
    if (appConfig.serveStatic) {
        const staticCache = await cacheStaticSource()
        if (staticCache !== null) {
            staticCache.forEach((value, key) => {
                // feat-112: like the fallback route below, a throw must not become an unhandled
                // rejection (which stops the server) and must still answer the request.
                server.get(key, (res, req) => {
                    staticCacheHandler(res, req, value).catch((err: unknown) => {
                        logger.error({ err, url: key }, 'Unhandled static cache handler error')
                        try {
                            sendErrorResponse(res, 500, {
                                status: 'error',
                                code: 'internal_error',
                                message: 'Internal error',
                            })
                        } catch {
                            // Aborted or already answered: nothing left to send.
                        }
                    })
                })
            })
        }
    }

    routes.httpRoutes.forEach((route: NormalizedRouteItem) => {
        registerHttpRoute(server, route)
    })
    if (appConfig.env === 'manual-test' && appConfig.docPage && appConfig.serveStatic) {
        server.get(`/${appConfig.pathPrefix}/doc/routes`, (res, req) => {
            // An API path like any other: it spends the same L1 budget.
            const responseData = createResponseData()
            if (!checkGlobalRateLimit(getIP(req, res), responseData)) {
                const origin = req.getHeader('origin')
                res.cork(() => {
                    sendResponse(res, responseData, origin)
                })
                return
            }
            docRoutesHandler(res, req, routes)
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
            res.cork(() => {
                writeHttpStatus(res, 200)
                setSecurityHeaders(res)
                setCorsHeader(res, origin)
                res.end()
            })
        } else if (isApiPath && method !== 'options') {
            // With the request's origin: a cross-origin SPA has to be able to read the 404
            // (feat-159), like every other error answer.
            sendErrorResponse(
                res,
                404,
                { status: 'error', code: 'not_found', message: 'Route not found' },
                {},
                { origin },
            )
        } else if (appConfig.serveStatic && method === 'get') {
            void staticHandler(res, req).catch((err: unknown) => {
                const error = err instanceof Error ? err : new Error(String(err))
                logger.error({ err: error, url }, 'Unhandled static handler error')
            })
        } else {
            sendErrorResponse(
                res,
                404,
                { status: 'error', code: 'not_found', message: 'Not found' },
                {},
                { origin },
            )
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
const initServer = async (routes: ServerRoutes): Promise<void> => {
    configureWebsockets(server, routes.wsRoutesByUrl)
    await configureHttp(server, routes)
    // feat-112: a failed listen (port taken, a socket path the OS refuses, one over its length
    // limit) gives `false`. It used to be logged as success (unix) or only logged (TCP), leaving a
    // process that serves nothing. Now it rejects, and startup exits with the reason.
    const unixPath = appConfig.unixPath
    const where =
        unixPath !== undefined
            ? `unix socket ${unixPath}`
            : `http://${appConfig.host}:${String(appConfig.port)}`
    const token = await new Promise<uWS.us_listen_socket | false>((resolve) => {
        if (unixPath !== undefined) {
            server.listen_unix(resolve, unixPath)
        } else {
            server.listen(appConfig.host, appConfig.port, resolve)
        }
    })
    if (token === false) {
        throw new Error(`Failed to listen on ${where}`)
    }
    state['listenSocket'] = token
    logger.info(`Listening ${where}`)
}

const stopServer = async (type = 'handle'): Promise<void> => {
    logger.info(`server stop type: ${type}`)
    try {
        // feat-112: stop accepting first, so no connection arrives while the open ones close.
        if (state['listenSocket'] !== undefined) {
            uWS.us_listen_socket_close(state['listenSocket'] as uWS.us_listen_socket)
        }
        state['listenSocket'] = undefined
        await closeAllWs()
    } catch (error) {
        logger.error({ err: error }, 'Server stop failed')
    }
}

export { initServer, stopServer, broadcastToChannel }
