import logger from '#vendor/utils/logger.js'
import { abortConnection } from './ws-connection-signal.js'
import wsApiHandler from '../routing/ws-api-dispatcher.js'
import { generateUUID } from 'metautil'
import type {
    HttpRequest,
    HttpResponse,
    us_socket_context_t,
    UserData,
} from '#vendor/start/server.js'

import type {
    MyWebSocket,
    UserConnection,
    WsResponseData,
    WsMessage,
    WsRoutes,
} from '#vendor/types/types.js'
import { wsSessionHandler } from '../session/session-handler.js'
import getIP from './get-ip.js'
import checkUpgradeRateLimit, {
    checkUpgradeRateLimitShared,
    type UpgradeRateLimitResult,
} from '#vendor/utils/rate-limit/upgrade-rate-limit.js'
import { makeJson } from '#vendor/utils/helpers/json-handlers.js'
import configApp from '#config/app.js'
import configWebsocket from '#config/websocket.js'
import {
    WS_CLOSE_MESSAGE_FLOOD,
    admitWsMessage,
    admitWsPing,
    createWsMessageBudget,
    releaseWsHandler,
    secondsToNextWindow,
    type WsMessageBudgetState,
} from '#vendor/utils/rate-limit/ws-message-budget.js'
import { createWsRateLimitErrorResponse } from '#vendor/utils/rate-limit/ws-rate-limit.js'
import {
    acquireWsConnection,
    releaseWsConnection,
} from '#vendor/utils/rate-limit/ws-connection-limit.js'
import { clientKey } from '#vendor/utils/rate-limit/rate-limit-store.js'
import { findWsRoute } from '#vendor/utils/routing/ws-route-lookup.js'
import type { Validator } from '#vendor/contracts/validator.js'
import { ValidationError } from '#app/validate/errors/validation-error.js'
import { MalformedBodyError } from '#vendor/utils/network/errors/malformed-body-error.js'
import {
    classifiedErrorBody,
    classifyError,
    logClassifiedError,
    type ClassifiedError,
} from '#vendor/utils/network/errors/classify-error.js'
import { createWsErrorEnvelope } from '#vendor/utils/network/ws-error-envelope.js'
import { endSessionExpired } from '#vendor/utils/network/ws-session-expired.js'
import { ab2str } from '#vendor/utils/helpers/ab2str.js'

// ---------------------------------------------------------------------------
// App hooks — registered at startup from app/start/index.ts
// ---------------------------------------------------------------------------

export type UpgradeTokenResult =
    | { kind: 'ok'; sessionId: string; userId: string; userToken: string }
    | { kind: 'missing' }
    | { kind: 'unavailable' }

export interface WsAppHooks {
    onUpgrade: (token: string) => Promise<UpgradeTokenResult>
    /** Rejects with RedisUnavailableError while Redis is down. */
    onConnected: (ws: MyWebSocket, userData: UserConnection) => Promise<void>
    onDisconnected: (ws: MyWebSocket, userData: UserConnection, code: number) => Promise<void>
}

let appHooks: WsAppHooks | null = null
let wsMessageValidator: Validator<WsMessage> | null = null

export const registerWsAppHooks = (hooks: WsAppHooks): void => {
    appHooks = hooks
}

export const registerWsMessageValidator = (validator: Validator<WsMessage>): void => {
    wsMessageValidator = validator
}

const getAppHooks = (): WsAppHooks => {
    if (appHooks === null) {
        throw new Error(
            'WS app hooks not registered. Call registerWsAppHooks() before starting the server.',
        )
    }
    return appHooks
}

const getWsMessageValidator = (): Validator<WsMessage> => {
    if (wsMessageValidator === null) {
        throw new Error(
            'WS message validator not registered. Call registerWsMessageValidator() before starting the server.',
        )
    }

    return wsMessageValidator
}

// ---------------------------------------------------------------------------
// Transport-level socket tracking (for closeAllWs only)
// ---------------------------------------------------------------------------

const wsStorage: Set<MyWebSocket> = new Set<MyWebSocket>()

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const sendJson = (ws: MyWebSocket, data: WsResponseData, userData?: UserConnection): void => {
    if (typeof ws.cork !== 'function') {
        logger.warn('Attempted to send message to closed or invalid WebSocket')
        return
    }
    // feat-124: the client went away while the handler worked (an AI answer, a slow query).
    // Nobody to answer, and touching the dead socket would throw twice (send, then close).
    if (userData?.closed === true) {
        logger.debug({ event: data.event }, 'WebSocket closed before the reply, nothing sent')
        return
    }
    try {
        let result = 1
        ws.cork(() => {
            result = ws.send(makeJson(data))
        })
        // 2: uWS dropped the message, the socket is over maxBackpressure (feat-107). The client
        // would wait for a reply that never comes; closing lets it reconnect.
        if (result === 2) {
            logger.warn(
                { event: data.event, bufferedAmount: ws.getBufferedAmount() },
                'WebSocket message dropped by backpressure, closing the connection',
            )
            ws.end(1013, 'Backpressure')
        }
    } catch (e) {
        logger.error({ err: e }, 'Error in sendJson:')
        try {
            ws.close()
        } catch (closeError) {
            logger.error({ err: closeError }, 'Error closing WebSocket after send failure:')
        }
    }
}

// Redis is down: the connection stays open, only this request fails. Same shape
// as createWsRateLimitErrorResponse, with the request's event so the client
// rejects the matching promise at once.
const serviceUnavailableMessage = (event: string, id: string | undefined): WsResponseData => ({
    event,
    ...(id !== undefined ? { id } : {}),
    status: 'error',
    data: null,
    timestamp: Date.now(),
    error: createWsErrorEnvelope(
        'service_unavailable',
        'Service temporarily unavailable. Try again later.',
    ),
})

const routeNotFoundMessage = (message: WsMessage): WsResponseData => ({
    event: message.event,
    ...(message.id !== undefined ? { id: message.id } : {}),
    status: 'error',
    data: null,
    timestamp: message.timestamp,
    error: createWsErrorEnvelope('not_found', 'Route not found'),
})

const closeExpiredSession = (ws: MyWebSocket, userData: UserConnection): void => {
    // feat-128: the session lookup before this is awaited; a socket that closed meanwhile is
    // gone already, and touching it would throw.
    if (userData.closed === true) return
    try {
        endSessionExpired(ws)
    } catch (e) {
        logger.error({ err: e }, 'Error ws send unAuthorizedMessage')
    }
}

const checkToken = (token: string): boolean =>
    token !== '' && token.length === configApp.accessTokenLength && /^[a-zA-Z0-9]+$/.test(token)

const normalizeAppTypeProtocol = (rawAppType: string): 'web' | 'pwa' => {
    if (rawAppType === '' || rawAppType === 'app-web') {
        return 'web'
    }
    if (rawAppType === 'app-pwa') {
        return 'pwa'
    }

    logger.warn({ rawAppType }, 'user_online: invalid app type protocol, falling back to web')
    return 'web'
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

// feat-112: every socket gets 4201, whatever Redis does. feat-196: there is no token left to
// revoke, the upgrade consumed it.
// feat-138 (sixth review L12): cleared by closeAllWs. An upgrade still waiting on its token check
// when the shutdown began would otherwise open a socket after every socket was closed; it is
// answered 503 instead.
let acceptingUpgrades = true

/** Test hook: a module-level flag outlives one test's shutdown. */
const __acceptUpgradesForTests = (): void => {
    acceptingUpgrades = true
}

// Async for its callers: the shutdown awaits it between its other steps.
// eslint-disable-next-line @typescript-eslint/require-await
const closeAllWs = async (): Promise<void> => {
    acceptingUpgrades = false
    for (const ws of [...wsStorage]) {
        try {
            ws.end(4201)
        } catch (e) {
            logger.error({ err: e }, 'closeAllWs error')
        }
    }
    wsStorage.clear()
}

// ---------------------------------------------------------------------------
// uWS callbacks
// ---------------------------------------------------------------------------

const messageBudgetOf = (userData: UserConnection, now: number): WsMessageBudgetState => {
    userData.messageBudget ??= createWsMessageBudget(now)
    return userData.messageBudget
}

// feat-149: a connection that keeps flooding. 4029 is in the range the client does not
// reconnect on. A socket that closed meanwhile is gone already.
const closeFloodingConnection = (ws: MyWebSocket, userData: UserConnection): void => {
    if (userData.closed === true) return
    logger.warn(
        { userId: userData.userId, messages: userData.messageBudget?.messages },
        'WebSocket closed: message budget exceeded repeatedly',
    )
    try {
        ws.end(WS_CLOSE_MESSAGE_FLOOD, 'Too many messages')
    } catch (e) {
        logger.error({ err: e }, 'Error closing a flooding WebSocket')
    }
}

/** 1003: the endpoint received a type of data it cannot accept (RFC 6455). */
const WS_CLOSE_UNSUPPORTED_DATA = 1003

const closeBinaryConnection = (ws: MyWebSocket, userData: UserConnection): void => {
    if (userData.closed === true) return
    logger.warn({ userId: userData.userId }, 'WebSocket closed: binary frames are not supported')
    try {
        ws.end(WS_CLOSE_UNSUPPORTED_DATA, 'Binary frames are not supported')
    } catch (e) {
        logger.error({ err: e }, 'Error closing a WebSocket after a binary frame')
    }
}

// A message over the budget (or over the running handlers) is answered with the request's event
// and id when they can be read, so the client rejects the matching promise at once (ADR 0006:
// a reply is matched by its id, feat-185); nothing else runs for it: no Redis, no session.
const refuseOverBudget = (
    ws: MyWebSocket,
    jsonMessage: string,
    userData: UserConnection,
    budget: WsMessageBudgetState,
    now: number,
): void => {
    let identity: Pick<RequestIdentity, 'event' | 'id'> = { event: '', id: undefined }
    try {
        identity = requestIdentity(JSON.parse(jsonMessage))
    } catch {
        // Not JSON: answered without an event, like a malformed message.
    }
    sendJson(
        ws,
        {
            ...createWsRateLimitErrorResponse(
                'Too many messages',
                secondsToNextWindow(budget, now),
                identity.event,
            ),
            ...(identity.id !== undefined ? { id: identity.id } : {}),
        },
        userData,
    )
}

const onMessage = async (
    ws: MyWebSocket,
    wsMessage: ArrayBuffer,
    isBinary: boolean,
    wsRoutesByUrl: Readonly<WsRoutes>,
): Promise<void> => {
    const userData = ws.getUserData()
    // feat-197 (L-11): the protocol is text only. A binary frame used to be dropped before the
    // message budget saw it, with an error line each, so a client could send them (up to
    // maxPayloadLength) at any rate. The first one closes the connection.
    if (isBinary) {
        closeBinaryConnection(ws, userData)
        return
    }
    const jsonMessage = ab2str(wsMessage)

    const now = Date.now()
    const budget = messageBudgetOf(userData, now)

    // Heartbeat confirms the transport and costs no Redis command (feat-196: the WS token is
    // consumed by the upgrade, there is nothing to refresh).
    if (jsonMessage === 'ping') {
        try {
            ws.send('pong')
        } catch (e) {
            logger.error({ err: e }, 'Error ws send pong')
        }
        // Heartbeats have a budget of their own: a flood of them closes the connection.
        if (admitWsPing(budget, configWebsocket, now) === 'close') {
            closeFloodingConnection(ws, userData)
        }
        return
    }

    // First, from memory: a valid message below costs a session read, a Redis command and a
    // PostgreSQL query (feat-149).
    const admission = admitWsMessage(budget, configWebsocket, now)
    if (admission === 'close') {
        closeFloodingConnection(ws, userData)
        return
    }
    if (admission === 'refuse') {
        refuseOverBudget(ws, jsonMessage, userData, budget, now)
        return
    }

    try {
        await handleAdmittedMessage(ws, jsonMessage, userData, wsRoutesByUrl)
    } finally {
        releaseWsHandler(budget)
    }
}

const handleAdmittedMessage = async (
    ws: MyWebSocket,
    jsonMessage: string,
    userData: UserConnection,
    wsRoutesByUrl: Readonly<WsRoutes>,
): Promise<void> => {
    let parsedMessage: unknown
    try {
        parsedMessage = JSON.parse(jsonMessage)
    } catch {
        // A client error like a malformed HTTP body: warn, no message text, no Sentry.
        sendWsError(
            ws,
            { event: '', timestamp: 0, id: undefined },
            classifyAndLog(new MalformedBodyError('json')),
            userData,
        )
        return
    }

    // Known before validation, so even a validation failure answers the request's
    // event and id, and the client can match it.
    const { event, timestamp, id } = requestIdentity(parsedMessage)

    try {
        const validatedMessage = getWsMessageValidator().validate(parsedMessage)
        if (!validatedMessage.ok) {
            const error = new ValidationError(
                validatedMessage.messages,
                undefined,
                validatedMessage.issues,
            )
            sendWsError(ws, { event, timestamp, id }, classifyAndLog(error), userData)
            return
        }
        const message = validatedMessage.value

        // feat-197 (M-4): an event no route answers is refused here, from memory. It used to
        // cost a session read (a Redis command and a PostgreSQL query on the pool the HTTP
        // session checks share) before the dispatcher said not_found, and no route limit
        // applies to it.
        if (findWsRoute(wsRoutesByUrl, message.event) === undefined) {
            sendJson(ws, routeNotFoundMessage(message), userData)
            return
        }

        const { sessionId, userToken } = userData
        const sessionResult =
            sessionId !== undefined && userToken !== undefined
                ? await wsSessionHandler(sessionId, userToken)
                : ({ kind: 'missing' } as const)

        if (sessionResult.kind === 'unavailable') {
            sendJson(ws, serviceUnavailableMessage(message.event, message.id), userData)
        } else if (sessionResult.kind === 'missing') {
            closeExpiredSession(ws, userData)
        } else {
            // The dispatcher always answers.
            const result = await wsApiHandler(
                message,
                ws,
                userData,
                sessionResult.session,
                wsRoutesByUrl,
            )
            sendJson(ws, result, userData)
        }
    } catch (err: unknown) {
        sendWsError(ws, { event, timestamp, id }, classifyAndLog(err), userData)
    }
}

interface RequestIdentity {
    event: string
    timestamp: number
    id: string | undefined
}

/**
 * `event` / `timestamp` / `id` of a parsed message when they have the right type, else empty.
 * The id is echoed only when it is one the envelope allows (a non-empty string ≤ 64).
 */
const requestIdentity = (parsed: unknown): RequestIdentity => {
    const record = typeof parsed === 'object' && parsed !== null ? parsed : {}
    const event = (record as { event?: unknown }).event
    const timestamp = (record as { timestamp?: unknown }).timestamp
    const id = (record as { id?: unknown }).id
    return {
        event: typeof event === 'string' ? event : '',
        timestamp: typeof timestamp === 'number' ? timestamp : 0,
        id: typeof id === 'string' && id.length > 0 && id.length <= 64 ? id : undefined,
    }
}

const classifyAndLog = (err: unknown): ClassifiedError => {
    const classified = classifyError(err)
    logClassifiedError(logger, classified)
    return classified
}

const sendWsError = (
    ws: MyWebSocket,
    { event, timestamp, id }: RequestIdentity,
    classified: ClassifiedError,
    userData?: UserConnection,
): void => {
    const { code, message, details } = classifiedErrorBody(classified)
    sendJson(
        ws,
        {
            status: 'error',
            error: createWsErrorEnvelope(
                code,
                message,
                details !== undefined ? { details } : undefined,
            ),
            event,
            ...(id !== undefined ? { id } : {}),
            timestamp,
            data: null,
        },
        userData,
    )
}

const onOpen = (ws: MyWebSocket): void => {
    try {
        logger.info('onOpen ws')
        const userData = ws.getUserData()

        if (userData.userId === undefined || userData.sessionId === undefined) {
            logger.warn(
                { userId: userData.userId, sessionId: userData.sessionId },
                'Closing WS connection: missing auth data',
            )
            try {
                endSessionExpired(ws)
            } catch (e) {
                logger.error({ err: e }, 'Error sending unauthorized message:')
            }
            return
        }

        sendJson(ws, {
            event: 'service:connection_established',
            status: '200',
            error: null,
            timestamp: Date.now(),
            data: {
                socket_id: userData.uuid,
                activity_timeout: 30,
            },
        })

        wsStorage.add(ws)
        logger.info(`onOpen ws userId: ${userData.userId}`)

        void (async (): Promise<void> => {
            try {
                await getAppHooks().onConnected(ws, userData)
            } catch (e) {
                logger.error({ err: e }, 'Error in onConnected hook')
                // feat-133 (P3): the client already has connection_established, but the
                // connection never entered the registry (a database error reading the role):
                // no broadcasts reach it and pushes go out as if the user were offline. Closed
                // with 1011, the client reconnects and registers. A socket that closed meanwhile
                // is gone already and is not touched.
                if (userData.closed === true) return
                try {
                    ws.end(1011, 'Server error')
                } catch (closeError) {
                    logger.error(
                        { err: closeError },
                        'Error closing a WebSocket after a failed onConnected',
                    )
                }
            }
        })()
    } catch (e) {
        logger.error({ err: e }, 'Error in onOpen:')
        try {
            ws.end(4001)
        } catch (closeError) {
            logger.error({ err: closeError }, 'Error closing connection:')
        }
    }
}

const onClose = async (ws: MyWebSocket, code: number, message: ArrayBuffer): Promise<void> => {
    // First, so work running for this connection (AI streaming) stops.
    abortConnection(ws)
    logger.info({ code }, 'onClose code')
    logger.info({ message }, 'onClose message')

    // feat-107: uWS invalidates the socket once this handler returns, and every access after an
    // await throws. Everything that needs the socket happens before the first await: read its
    // data, mark it closed, drop it from wsStorage, and start onDisconnected, whose synchronous
    // part takes it out of the connection registry. Only then the Redis round trip.
    let userData: UserConnection
    try {
        userData = ws.getUserData()
        userData.closed = true
    } catch (e) {
        logger.error({ err: e }, 'Error onClose')
        return
    }
    wsStorage.delete(ws)

    // feat-197: the place this connection took at upgrade is free again.
    const slot = userData.connectionSlot
    if (slot !== undefined) {
        userData.connectionSlot = undefined
        releaseWsConnection(slot)
    }

    const { userId, sessionId } = userData
    let disconnected: Promise<void> | undefined
    if (userId !== undefined && sessionId !== undefined) {
        try {
            disconnected = getAppHooks().onDisconnected(ws, userData, code)
        } catch (e) {
            logger.error({ err: e }, 'Error in onDisconnected hook')
        }
    }

    if (disconnected !== undefined) {
        try {
            await disconnected
        } catch (e) {
            logger.error({ err: e }, 'Error in onDisconnected hook')
        }
    }
}

// A place frees when one of the open connections closes; nothing says when.
const WS_CONNECTION_LIMIT_RETRY_AFTER_SECONDS = 5

const rejectUpgrade = (
    res: HttpResponse,
    result: Exclude<UpgradeRateLimitResult, { kind: 'allowed' }>,
): void => {
    res.cork(() => {
        if (result.kind === 'limited') {
            res.writeStatus('429 Too Many Requests')
                .writeHeader('Retry-After', String(result.retryAfter))
                .end('Too many WebSocket upgrade requests')
        } else {
            res.writeStatus('503 Service Unavailable').end('Rate limit check failed')
        }
    })
}

// uWS calls the upgrade handler and drops its promise: a rejection would be unhandled, and with no
// unhandledRejection listener (index.ts) it stops the process. Any unexpected error is therefore
// logged and answered 500 here (while the client is still there), never rethrown.
const handleUpgrade = async (
    res: HttpResponse,
    req: HttpRequest,
    context: us_socket_context_t,
): Promise<void> => {
    logger.info('handleUpgrade')
    let aborted = false as boolean
    // A function call: TypeScript keeps `aborted` narrowed to false across `await`.
    const isAborted = (): boolean => aborted
    res.onAborted(() => {
        logger.warn('Client aborted before operation completed')
        aborted = true
    })

    try {
        await upgradeConnection(res, req, context, isAborted)
    } catch (err: unknown) {
        logger.error({ err }, 'WebSocket upgrade failed')
        if (isAborted()) return
        try {
            res.cork(() => {
                res.writeStatus('500 Internal Server Error').end()
            })
        } catch (writeErr: unknown) {
            // The response was already written or the socket is gone: nothing more to send.
            logger.warn({ err: writeErr }, 'WebSocket upgrade failure could not be answered')
        }
    }
}

const upgradeConnection = async (
    res: HttpResponse,
    req: HttpRequest,
    context: us_socket_context_t,
    isAborted: () => boolean,
): Promise<void> => {
    const secWebsocketKey = req.getHeader('sec-websocket-key')
    const secWebsocketProtocol = req.getHeader('sec-websocket-protocol')
    const secWebsocketExtensions = req.getHeader('sec-websocket-extensions')
    const userAgent = req.getHeader('user-agent')
    const ip = getIP(req, res)

    // Level 1 (per process, sync) before any I/O: a flood of upgrades costs nothing.
    const localLimit = checkUpgradeRateLimit(ip)
    if (localLimit.kind !== 'allowed') {
        rejectUpgrade(res, localLimit)
        return
    }

    // Level 2 (cluster-wide, Redis), still before the token check and the session lookup.
    const sharedLimit = await checkUpgradeRateLimitShared(ip)
    if (isAborted()) return
    if (sharedLimit.kind !== 'allowed') {
        rejectUpgrade(res, sharedLimit)
        return
    }

    const protocols = secWebsocketProtocol
        .split(',')
        .map((value) => value.trim())
        .filter((value) => value !== '')

    // Token is transmitted via Sec-WebSocket-Protocol header (the only custom
    // header the browser WebSocket API supports). The client sends the auth
    // token first and the app-type marker second. The server must echo back
    // only the selected subprotocol, otherwise browsers reject the handshake.
    const token = protocols[0] ?? ''
    const appType = normalizeAppTypeProtocol(protocols[1] ?? '')

    if (!checkToken(token)) {
        // After the level 2 await: corked, like every other write here.
        res.cork(() => {
            res.writeStatus('401 Unauthorized').end('Invalid token format')
        })
        return
    }

    const tokenResult = await getAppHooks().onUpgrade(token)
    if (isAborted()) return

    if (tokenResult.kind === 'unavailable') {
        res.cork(() => {
            res.writeStatus('503 Service Unavailable')
                .writeHeader('Retry-After', '1')
                .end('Service temporarily unavailable')
        })
        return
    }

    // No live session for a well-formed token: refuse before upgrading instead of
    // opening a connection only to close it in onOpen (code-issues item 18). The
    // browser sees a failed handshake (close 1006); the frontend then refreshes
    // the WS token over HTTP, as it does for 4001.
    if (tokenResult.kind === 'missing') {
        res.cork(() => {
            res.writeStatus('401 Unauthorized').end('Session expired')
        })
        return
    }

    if (!acceptingUpgrades) {
        res.cork(() => {
            res.writeStatus('503 Service Unavailable').end('Server is shutting down')
        })
        return
    }

    const dataAccess = tokenResult

    // feat-197 (M-4): a place among the connections of this user and of this address. Taken
    // here, with nothing awaited between the check and res.upgrade, and given back in onClose.
    const admission = acquireWsConnection(dataAccess.userId, clientKey(ip), configWebsocket)
    if (admission.kind === 'limited') {
        logger.warn(
            { userId: dataAccess.userId, ip, by: admission.by },
            'WebSocket upgrade refused: too many open connections',
        )
        res.cork(() => {
            res.writeStatus('429 Too Many Requests')
                .writeHeader('Retry-After', String(WS_CONNECTION_LIMIT_RETRY_AFTER_SECONDS))
                .end('Too many open WebSocket connections')
        })
        return
    }

    res.cork(() => {
        const userData: UserData = {
            ip,
            ip2: ab2str(res.getProxiedRemoteAddressAsText()),
            user: null,
            uuid: generateUUID(),
            sessionId: dataAccess.sessionId,
            userId: dataAccess.userId,
            userToken: dataAccess.userToken,
            timeStart: Date.now(),
            userAgent,
            appType,
            connectionSlot: admission.slot,
        }
        try {
            res.upgrade(userData, secWebsocketKey, token, secWebsocketExtensions, context)
        } catch (err) {
            // No connection, so no close handler will give the place back.
            releaseWsConnection(admission.slot)
            throw err
        }
    })
}

export { onMessage, onOpen, onClose, handleUpgrade, closeAllWs, __acceptUpgradesForTests }
