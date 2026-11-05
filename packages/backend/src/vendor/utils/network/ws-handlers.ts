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
import type { Validator } from '#vendor/contracts/validator.js'
import { ValidationError } from '#app/validate/errors/validation-error.js'
import { RedisUnavailableError } from '#vendor/utils/network/errors/redis-unavailable-error.js'
import { MalformedBodyError } from '#vendor/utils/network/errors/malformed-body-error.js'
import {
    classifiedErrorBody,
    classifyError,
    logClassifiedError,
    type ClassifiedError,
} from '#vendor/utils/network/errors/classify-error.js'
import { createWsErrorEnvelope } from '#vendor/utils/network/ws-error-envelope.js'
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
    onRefreshToken: (token: string) => Promise<void>
    onRevokeToken: (token: string) => Promise<void>
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

const unAuthorizedMessage = (): WsResponseData => ({
    event: 'service:error',
    status: 'error',
    data: null,
    timestamp: Date.now(),
    error: createWsErrorEnvelope('unauthorized', `Session expired. Please login again.`, {
        reason: 'session_expired',
    }),
})

// Redis is down: the connection stays open, only this request fails. Same shape
// as createWsRateLimitErrorResponse, with the request's event so the client
// rejects the matching promise at once.
const serviceUnavailableMessage = (event: string): WsResponseData => ({
    event,
    status: 'error',
    data: null,
    timestamp: Date.now(),
    error: createWsErrorEnvelope(
        'service_unavailable',
        'Service temporarily unavailable. Try again later.',
    ),
})

const closeExpiredSession = (ws: MyWebSocket, userData: UserConnection): void => {
    // feat-128: the session lookup before this is awaited; a socket that closed meanwhile is
    // gone already, and touching it would throw.
    if (userData.closed === true) return
    ws.cork(() => {
        try {
            ws.send(makeJson(unAuthorizedMessage()))
            ws.end(4001)
        } catch (e) {
            logger.error({ err: e }, 'Error ws send unAuthorizedMessage')
        }
    })
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

// feat-112: every socket gets 4201 first, whatever Redis does; the token revokes then run
// together and a failing one is only logged. (onClose revokes too; a DEL is idempotent.)
const closeAllWs = async (): Promise<void> => {
    const hooks = getAppHooks()
    const tokens: string[] = []
    for (const ws of [...wsStorage]) {
        try {
            const token = ws.getUserData().token
            if (token !== '') tokens.push(token)
            ws.end(4201)
        } catch (e) {
            logger.error({ err: e }, 'closeAllWs error')
        }
    }
    wsStorage.clear()

    const revoked = await Promise.allSettled(tokens.map((token) => hooks.onRevokeToken(token)))
    const failed = revoked.filter((outcome) => outcome.status === 'rejected').length
    if (failed > 0) {
        logger.warn({ failed, total: tokens.length }, 'closeAllWs: some WS tokens were not revoked')
    }
}

// ---------------------------------------------------------------------------
// uWS callbacks
// ---------------------------------------------------------------------------

/** Resolves false when Redis is unavailable; other errors are logged as before. */
const refreshToken = async (token: string): Promise<boolean> => {
    try {
        await getAppHooks().onRefreshToken(token)
    } catch (error: unknown) {
        if (error instanceof RedisUnavailableError) return false
        logger.error({ err: error }, 'Error refresh token')
    }
    return true
}

const onMessage = async (
    ws: MyWebSocket,
    wsMessage: ArrayBuffer,
    isBinary: boolean,
    wsRoutesByUrl: Readonly<WsRoutes>,
): Promise<void> => {
    if (isBinary) {
        logger.error('onMessage isBinary is not supported')
        return
    }
    const jsonMessage = ab2str(wsMessage)
    const userData = ws.getUserData()

    const token = userData.token

    // Heartbeat confirms the transport, not Redis: pong first, with no Redis
    // command before it; the token refresh for ping runs after and is not awaited.
    if (jsonMessage === 'ping') {
        try {
            ws.send('pong')
        } catch (e) {
            logger.error({ err: e }, 'Error ws send pong')
        }
        if (token !== '') void refreshToken(token)
        return
    }

    // false: Redis is unavailable (already reported by redis-health, no log here).
    const refreshed = token === '' ? true : await refreshToken(token)

    let parsedMessage: unknown
    try {
        parsedMessage = JSON.parse(jsonMessage)
    } catch {
        // A client error like a malformed HTTP body: warn, no message text, no Sentry.
        sendWsError(ws, '', 0, classifyAndLog(new MalformedBodyError('json')), userData)
        return
    }

    // Known before validation, so even a validation failure answers the request's
    // event and the client can match it.
    const { event, timestamp } = requestIdentity(parsedMessage)

    try {
        const validatedMessage = getWsMessageValidator().validate(parsedMessage)
        if (!validatedMessage.ok) {
            const error = new ValidationError(
                validatedMessage.messages,
                undefined,
                validatedMessage.issues,
            )
            sendWsError(ws, event, timestamp, classifyAndLog(error), userData)
            return
        }
        const message = validatedMessage.value

        if (!refreshed) {
            sendJson(ws, serviceUnavailableMessage(message.event), userData)
            return
        }

        const { sessionId, userToken } = userData
        const sessionResult =
            sessionId !== undefined && userToken !== undefined
                ? await wsSessionHandler(sessionId, userToken)
                : ({ kind: 'missing' } as const)

        if (sessionResult.kind === 'unavailable') {
            sendJson(ws, serviceUnavailableMessage(message.event), userData)
        } else if (sessionResult.kind === 'missing') {
            closeExpiredSession(ws, userData)
        } else {
            // The dispatcher always answers, an unknown route included (not_found).
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
        sendWsError(ws, event, timestamp, classifyAndLog(err), userData)
    }
}

/** `event` / `timestamp` of a parsed message when they have the right type, else empty. */
const requestIdentity = (parsed: unknown): { event: string; timestamp: number } => {
    const record = typeof parsed === 'object' && parsed !== null ? parsed : {}
    const event = (record as { event?: unknown }).event
    const timestamp = (record as { timestamp?: unknown }).timestamp
    return {
        event: typeof event === 'string' ? event : '',
        timestamp: typeof timestamp === 'number' ? timestamp : 0,
    }
}

const classifyAndLog = (err: unknown): ClassifiedError => {
    const classified = classifyError(err)
    logClassifiedError(logger, classified)
    return classified
}

const sendWsError = (
    ws: MyWebSocket,
    event: string,
    timestamp: number,
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
            const errorMessage = unAuthorizedMessage()
            ws.cork(() => {
                try {
                    ws.send(makeJson(errorMessage))
                    ws.end(4001)
                } catch (e) {
                    logger.error({ err: e }, 'Error sending unauthorized message:')
                }
            })
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

    const { userId, sessionId } = userData
    let disconnected: Promise<void> | undefined
    if (userId !== undefined && sessionId !== undefined) {
        try {
            disconnected = getAppHooks().onDisconnected(ws, userData, code)
        } catch (e) {
            logger.error({ err: e }, 'Error in onDisconnected hook')
        }
    }

    const token = userData.token
    if (token !== '') {
        try {
            await getAppHooks().onRevokeToken(token)
        } catch (e) {
            logger.error({ err: e }, 'Error in onRevokeToken hook')
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
    if (aborted) return
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

    const dataAccess = tokenResult
    res.cork(() => {
        const userData: UserData = {
            ip,
            ip2: ab2str(res.getProxiedRemoteAddressAsText()),
            token,
            user: null,
            uuid: generateUUID(),
            sessionId: dataAccess.sessionId,
            userId: dataAccess.userId,
            userToken: dataAccess.userToken,
            timeStart: Date.now(),
            userAgent,
            appType,
        }
        res.upgrade(userData, secWebsocketKey, token, secWebsocketExtensions, context)
    })
}

export { onMessage, onOpen, onClose, handleUpgrade, closeAllWs }
