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

const sendJson = (ws: MyWebSocket, data: WsResponseData): void => {
    if (typeof ws.cork !== 'function') {
        logger.warn('Attempted to send message to closed or invalid WebSocket')
        return
    }
    try {
        ws.cork(() => {
            ws.send(makeJson(data))
        })
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

const closeExpiredSession = (ws: MyWebSocket): void => {
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

const closeAllWs = async (): Promise<void> => {
    const hooks = getAppHooks()
    for (const ws of wsStorage) {
        const userData = ws.getUserData()
        const token = userData.token
        if (token !== '') {
            await hooks.onRevokeToken(token)
        }
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

    let event = ''
    let timestamp = 0

    try {
        const parsedMessage: unknown = JSON.parse(jsonMessage)
        const validatedMessage = getWsMessageValidator().validate(parsedMessage)
        if (!validatedMessage.ok) {
            sendJson(ws, {
                status: 'error',
                error: createWsErrorEnvelope('validation_failed', 'Validation failure', {
                    details: {
                        kind: 'validation',
                        messages: validatedMessage.messages,
                        ...(validatedMessage.issues !== undefined
                            ? { issues: validatedMessage.issues }
                            : {}),
                    },
                }),
                event,
                timestamp,
                data: null,
            })
            return
        }
        const message = validatedMessage.value

        if (!refreshed) {
            sendJson(ws, serviceUnavailableMessage(message.event))
            return
        }

        const { sessionId, userToken } = userData
        const sessionResult =
            sessionId !== undefined && userToken !== undefined
                ? await wsSessionHandler(sessionId, userToken)
                : ({ kind: 'missing' } as const)

        if (sessionResult.kind === 'unavailable') {
            sendJson(ws, serviceUnavailableMessage(message.event))
        } else if (sessionResult.kind === 'missing') {
            closeExpiredSession(ws)
        } else {
            const { session } = sessionResult
            event = message.event
            timestamp = message.timestamp
            // The dispatcher always answers, an unknown route included (not_found).
            const result = await wsApiHandler(message, ws, userData, session, wsRoutesByUrl)
            sendJson(ws, result)
        }
    } catch (err: unknown) {
        logger.error({ err }, 'Error parse onMessage')
        if (err instanceof ValidationError) {
            sendJson(ws, {
                status: 'error',
                error: createWsErrorEnvelope('validation_failed', 'Validation failure', {
                    details: {
                        kind: 'validation',
                        messages: ['Validation failure'],
                    },
                }),
                event,
                timestamp,
                data: null,
            })
        } else {
            sendJson(ws, {
                status: 'error',
                error: createWsErrorEnvelope('internal_error', 'Internal server error'),
                event,
                timestamp,
                data: null,
            })
        }
    }
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
    try {
        const userData = ws.getUserData()

        const token = userData.token
        if (token !== '') {
            try {
                await getAppHooks().onRevokeToken(token)
            } catch (e) {
                logger.error({ err: e }, 'Error in onRevokeToken hook')
            }
        }

        wsStorage.delete(ws)

        const { userId, sessionId } = userData
        if (userId !== undefined && sessionId !== undefined) {
            try {
                await getAppHooks().onDisconnected(ws, userData, code)
            } catch (e) {
                logger.error({ err: e }, 'Error in onDisconnected hook')
            }
        }
    } catch (e) {
        logger.error({ err: e }, 'Error onClose')
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
