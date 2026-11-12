import type { WebSocket } from 'uWebSockets.js'
import type { Logger } from 'pino'
import type { BaseType } from '@arktype/type'
import type { InferPayload, Validator } from '#vendor/contracts/validator.js'
import type { BodyKind } from '../utils/network/http-request-handlers.js'
import type { ResponseCheck } from '../utils/validation/validate-response.js'
import type { WsMessageBudgetState } from '../utils/rate-limit/ws-message-budget.js'
import type { WsErrorBody, WsReplyEnvelope, WsRequestEnvelope } from 'shared/ws-client'

export type Payload = Record<string, unknown> | string | Buffer | number | boolean | bigint | null

export type Params = Record<string, string>

export type ValidatorFunction = (payload: Payload) => Promise<Payload>

export interface UserConnection extends Record<string, unknown> {
    ip: string
    userAgent: string
    ip2: string
    token: string
    user: unknown
    role?: 'user' | 'admin'
    appType: 'web' | 'pwa'
    isAdminChannelSubscribed?: boolean
    uuid: string
    sessionId: string | undefined
    userId: string | undefined
    userToken: string | undefined
    timeStart: number
    /**
     * Set synchronously when uWS runs the close handler: from then on the socket is dead and
     * every access to it throws. Work that awaited before touching the socket checks it (feat-107).
     */
    closed?: boolean
    /** feat-149: what the connection sent this minute; created with its first message. */
    messageBudget?: WsMessageBudgetState
}

export interface MyWebSocket extends WebSocket<UserConnection> {
    // sendJson: (data: any) => void;
    // timeout: NodeJS.Timeout,
    // UUID: string,
    id: string
}
export interface Header {
    name: string
    value: string
}
export interface Cookie {
    name: string
    value: string
    path: string | undefined
    httpOnly: boolean | undefined
    secure: boolean | undefined
    expires: Date | undefined
    maxAge: number | undefined
    sameSite: string | undefined
}

/**
 * The context of an HTTP handler. `TParams` are the path parameters: `defineRoute` passes those of
 * the route's contract (`:name` segments), so a handler that names another parameter does not
 * compile (feat-186).
 */
export interface HttpContext<TPayload = unknown, TQuery = null, TParams = Params> {
    requestId: string
    logger: Logger
    httpData: HttpData<TPayload, TQuery, TParams>
    responseData: ResponseData
    session: Session
    auth: Auth
    /** Aborted when the client disconnects before the response (res.onAborted). */
    signal: AbortSignal
}
export interface WsContext<TPayload = unknown> {
    requestId: string
    ws: MyWebSocket
    wsData: WsData<TPayload>
    responseData: WsResponseData
    userData: UserConnection | null
    session: null
    auth: null
    logger: Logger
    /** Aborted when this WebSocket connection closes. */
    signal: AbortSignal
}

export type Middleware<TContext = HttpContext> = (
    context: TContext,
    next: () => Promise<void>,
) => Promise<void>

export interface Auth {
    getUserId: () => string | null
    /**
     * The user token of the session cookie this request came with, once the session was
     * verified as current (ADR 0002), or undefined for an anonymous or revoked one. Fixed for
     * the whole request: a login, logout or renewal inside the request does not change it.
     * A change of credentials compares it with users.session_token in the same statement.
     */
    getPresentedUserToken: () => string | undefined
    check: () => boolean
    login: (userId: string | undefined, userToken: string | undefined) => Promise<boolean>
    logout: () => Promise<boolean>
    logoutAll: () => Promise<DestroyAllSessionsResult>
}

/** Outcome of deleting all sessions of a user (destroyAllSessions, auth.logoutAll). */
export interface DestroyAllSessionsResult {
    /**
     * Deletions Redis confirmed. A command still in flight when the deadline hit may delete
     * more after the answer was given up on, so the real count can be higher.
     */
    deleted: number
    /**
     * The SCAN reached cursor 0 without an error. Not a promise that no record is left: a
     * concurrent request can write one behind the scan. Such a record is already revoked
     * by the rotated session token, so it opens nothing.
     */
    complete: boolean
}

export interface Session {
    sessionInfo: SessionInfo | null
    updateSessionData: (newData: SessionData) => Promise<SessionInfo | null>
    changeSessionData: (newData: SessionData) => Promise<SessionInfo | null>
    /**
     * Removes `keys` only while every `expected` value is still stored, atomically (feat-119): of
     * two requests consuming the same single-use value one gets `consumed`, and a value replaced
     * meanwhile gives `mismatch` and stays.
     */
    consumeSessionData: (
        expected: Record<string, string>,
        keys: readonly string[],
    ) => Promise<'consumed' | 'mismatch' | 'gone'>
    /**
     * Whether the session's record is still stored (feat-123): a logout in another tab deletes
     * it without rotating users.session_token, so an operation that does not write to the session
     * asks right before its irreversible step (a mail, an SMS, a link). A cookie-held anonymous
     * session has no record: false.
     */
    isStored: () => Promise<boolean>
    /** Deletes the current session's record; it does not issue a new session. */
    destroySession: () => Promise<void>
    /** Run by the server after the handler, right before the response is sent. */
    beforeSend?: () => Promise<void>
}

export interface SessionData extends Record<string, unknown> {
    userId?: string
    userToken?: string
    wsToken?: string
    csrfToken?: string
}

export interface SessionInfo {
    id: string
    data: SessionData
    createdAt: string
    updatedAt?: string
    // expiresAt: string;
}

export interface UploadedFile {
    name: string
    filename: string
    type: string
    data: ArrayBuffer
}

export interface HttpData<TPayload = unknown, TQuery = null, TParams = Params> {
    method: Method
    ip: string | null | undefined
    params: TParams
    payload: TPayload | null
    /**
     * Validated, typed query object. NOT a raw URLSearchParams.
     * - When the route has no `queryValidator`, `TQuery` is inferred as `null`
     *   and reading any field is a TypeScript error (use `InferQuery` to infer).
     * - When the route has a `queryValidator`, `TQuery` is the schema's output
     *   type (after morphs and defaults applied).
     *
     * Duplicate keys are rejected (422) unless the route declares them in
     * `queryArrays`. Unknown keys are rejected (422) unless the route opts in
     * with `queryAllowExtra: true` (loose+strip — extras pass validation but
     * are stripped from this object).
     */
    query: TQuery
    headers: Map<string, string>
    contentType: string | undefined
    cookies: Map<string, string>
    isJson: boolean
    files: Map<string, UploadedFile> | null
    hasFile: (name: string) => boolean
}

/** The error envelope of a refused request (shared/ws-client, feat-184). */
export type ErrorResponse = WsErrorBody

/** A WS request as the server receives it: the envelope of shared/ws-client (feat-184). */
export type WsMessage = WsRequestEnvelope

/** A WS reply as the server sends it: the envelope of shared/ws-client (feat-184). */
export type WsResponseData = WsReplyEnvelope<Payload>

export interface WsData<TPayload = unknown> {
    ws: MyWebSocket
    middlewareData: Record<string, unknown>
    status: string
    payload: TPayload | Payload
}

export interface CookieOptions {
    path: string | undefined
    httpOnly: boolean | undefined
    secure: boolean | undefined
    maxAge: number | undefined
    sameSite: string | undefined
    expires: Date | undefined
}

export interface ResponseData {
    aborted: boolean
    payload: Payload | null
    middlewareData: Record<string, unknown>
    headers: Header[]
    cookies: Map<string, Cookie>
    status: number
    deleteCookie: (
        name: string,
        options?: {
            path?: string
            secure?: boolean
            sameSite?: string
        },
    ) => void
    setCookie: {
        (name: string, value: string, options?: CookieOptions): void
        (cookie: Cookie): void
    }
    setHeader: (name: string, value: string) => void
}

export type Method = 'get' | 'post' | 'del' | 'put' | 'patch' | 'ws' | 'delete' | 'options'
export type WsRoutes = Record<string, NormalizedRouteItem>
export interface RateLimit {
    windowMs: number
    maxRequests: number
}

// Handler types for routes
type HandlerReturn = Promise<Payload> | Payload
type BivariantHandler<TContext> = {
    bivarianceHack(context: TContext): HandlerReturn
}['bivarianceHack']

export type RouteHandler<TPayload = unknown, TQuery = null> = BivariantHandler<
    HttpContext<TPayload, TQuery> | WsContext<TPayload>
>
// Same bivariance trick as BivariantHandler, with a typed result for defineRoute, defineRawRoute /
// defineWsRoute / defineRawWsRoute routes that declare a ResponseSchema.
export type TypedHandler<TContext, TOut> = {
    bivarianceHack(context: TContext): TOut | Promise<TOut>
}['bivarianceHack']

// Base route configuration without handler (for defineRoute and defineRawRoute)
export interface RouteConfig<
    TValidator extends Validator<unknown> | undefined = undefined,
    TQueryValidator extends Validator<unknown> | undefined = undefined,
> {
    url: string
    method: Method
    /**
     * Set by `defineRawRoute({ contract })`: the route's whole path under the API prefix, as the
     * contract says it. The router checks that the group the route is in has that prefix, and
     * takes the URL from here (docs/adr/0005-route-contracts.md).
     */
    contractPath?: string | undefined
    middlewares?: string[] | undefined
    validator?: TValidator | undefined
    /**
     * Validator for the query string. When set, `httpData.query` becomes the
     * validated, typed object (not a raw URLSearchParams). When omitted,
     * `httpData.query === null` and reading any field is a TypeScript error.
     */
    queryValidator?: TQueryValidator | undefined
    /**
     * Loose+strip opt-out from default strict mode. When `true`, undeclared
     * query keys are accepted but stripped from `httpData.query` (they never
     * reach the controller). Default: undefined → strict (extras → 422).
     */
    queryAllowExtra?: boolean | undefined
    /**
     * Keys that may appear multiple times in the query. Listed keys are
     * collected via `URLSearchParams.getAll` into a `string[]`. Other keys
     * appearing more than once result in a 422 (duplicate key error).
     */
    queryArrays?: readonly string[] | undefined
    description?: string | undefined
    rateLimit?: RateLimit | undefined
    groupRateLimit?: RateLimit | undefined
    parametersKey?: string[]
    requestBody?: RequestSchema
    ResponseSchema?: BaseType | undefined
    /** Allowed request body Content-Type kinds. Defaults to ['json'] for POST/PUT routes. */
    allowedContentTypes?: BodyKind[] | undefined
    /**
     * Largest request body this route accepts, in bytes. The smaller of this and the
     * global limit of the body's kind applies (APP_MAX_*_BODY_SIZE), so a route can only
     * tighten it. For a multipart upload it is the whole body: the file plus its framing.
     */
    maxBodySize?: number | undefined
}

// RouteItem with handler - uses function overload pattern for type erasure
export interface RouteItem<
    TValidator extends Validator<unknown> | undefined = Validator<unknown> | undefined,
    TQueryValidator extends Validator<unknown> | undefined = Validator<unknown> | undefined,
> extends RouteConfig<TValidator, TQueryValidator> {
    handler: TValidator extends Validator<unknown>
        ? TQueryValidator extends Validator<unknown>
            ? RouteHandler<InferPayload<TValidator>, InferPayload<TQueryValidator>>
            : RouteHandler<InferPayload<TValidator>>
        : TQueryValidator extends Validator<unknown>
          ? RouteHandler<unknown, InferPayload<TQueryValidator>>
          : RouteHandler
}

/**
 * A route after routesHandler: responseCheck is always set, to the runtime
 * ResponseSchema check or to null for a route without a schema, so the request path
 * only compares it with null.
 */
export interface NormalizedRouteItem extends RouteItem {
    responseCheck: ResponseCheck | null
}

export interface ResponseSchema {
    type: string // Name of the response type
    description?: string
    example?: Record<string, unknown>
    schema?: Record<string, SchemaField>
}

export interface RequestSchema {
    description?: string
    example?: Record<string, unknown>
    schema?: Record<string, SchemaField>
}

export interface SchemaField {
    type: 'string' | 'number' | 'boolean' | 'object' | 'array'
    description?: string
    required?: boolean
    example?: Record<string, unknown>
    items?: SchemaField // For arrays
    properties?: Record<string, SchemaField> // For objects
}
export interface groupRouteItem {
    group: routeList
    middlewares?: string[]
    rateLimit?: RateLimit
    description?: string
    prefix: string
}

export interface WebSocketConnectionEvent {
    userId: string
    sessionId: string
    uuid: string
    ip: string
    userAgent: string
    timestamp: number
    ws: MyWebSocket
}

export interface WebSocketDisconnectionEvent {
    userId: string
    sessionId: string
    uuid: string
    code: number
    timestamp: number
}
export type routeList = (RouteItem | groupRouteItem)[]
