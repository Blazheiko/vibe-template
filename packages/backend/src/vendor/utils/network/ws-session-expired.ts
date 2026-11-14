import type { MyWebSocket, WsResponseData } from '#vendor/types/types.js'
import { makeJson } from '#vendor/utils/helpers/json-handlers.js'
import { createWsErrorEnvelope } from '#vendor/utils/network/ws-error-envelope.js'

/** Close code of a connection whose session is gone: the client asks for a new WS token. */
export const WS_CLOSE_SESSION_EXPIRED = 4001

export const sessionExpiredMessage = (): WsResponseData => ({
    event: 'service:error',
    status: 'error',
    data: null,
    timestamp: Date.now(),
    error: createWsErrorEnvelope('unauthorized', `Session expired. Please login again.`, {
        reason: 'session_expired',
    }),
})

/**
 * Tells the client its session is gone and closes the connection with 4001. Throws what
 * uWebSockets.js throws on a socket that has already closed; the caller decides what that means.
 */
export const endSessionExpired = (ws: MyWebSocket): void => {
    ws.cork(() => {
        ws.send(makeJson(sessionExpiredMessage()))
        ws.end(WS_CLOSE_SESSION_EXPIRED)
    })
}

// What uWebSockets.js throws on a socket that has already closed.
export const isClosedSocketError = (err: unknown): boolean =>
    err instanceof Error && /Invalid access of closed uWS\.(SSL)?WebSocket/.test(err.message)
