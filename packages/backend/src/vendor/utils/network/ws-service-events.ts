import logger from '#vendor/utils/logger.js'
import { makeJson } from '#vendor/utils/helpers/json-handlers.js'
import type { MyWebSocket, UserConnection } from '#vendor/types/types.js'

/**
 * feat-232: tells the client its socket is registered; the app calls it right after
 * `registerConnection`. From then on events to its user reach the socket, so a re-read of pushed
 * state done after this signal misses nothing. `service:connection_established` (ws-handlers.ts
 * onOpen) is sent earlier, before the session and role checks of the app.
 *
 * A module of its own, with no session or route imports, so the app's connection coordinator can
 * send it without loading the transport.
 */
export const sendConnectionReady = (ws: MyWebSocket, userData: UserConnection): void => {
    if (userData.closed === true) return
    try {
        let result = 1
        ws.cork(() => {
            result = ws.send(
                makeJson({
                    event: 'service:connection_ready',
                    status: '200',
                    error: null,
                    timestamp: Date.now(),
                    data: { socket_id: userData.uuid },
                }),
            )
        })
        // 2: dropped by backpressure. Without the signal the client would not re-read; closing
        // lets it reconnect, as the transport does for a dropped reply.
        if (result === 2) ws.end(1013, 'Backpressure')
    } catch (err) {
        logger.warn({ err, socketUuid: userData.uuid }, 'service:connection_ready not sent')
    }
}
