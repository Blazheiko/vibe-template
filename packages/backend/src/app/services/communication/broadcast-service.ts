import logger from '#logger'
import responseValidationConfig from '#config/response-validation.js'
import { broadcastToChannel } from '#vendor/start/server.js'
import { makeBroadcastJson } from '#vendor/utils/helpers/json-handlers.js'
import {
    createResponseCheck,
    type ResponseCheck,
    type ResponseCheckOptions,
} from '#vendor/utils/validation/validate-response.js'
import { wsConnectionRegistry } from '#app/websocket/ws-connection-registry.js'
import {
    BROADCAST_EVENT_NAMES,
    BroadcastEventSchemas,
    type BroadcastEventName,
    type BroadcastMessage,
} from 'shared/schemas'
import type { WsChannel } from 'shared/guards'
import type { MyWebSocket } from '#vendor/types/types.js'

// Every event is checked against its schema in shared/schemas/ws/broadcast-events.ts once,
// before serialization and before the loop over connections
// (docs/plan/ws-async-message-validation-plan.md §4.3). The mode is the response one:
// undeclared keys are stripped in log and drop the event in strict; a mismatch drops it
// in both. There is nobody to answer 500 to, so a dropped event is only logged.
export interface BroadcastService {
    broadcastMessageToUser(userId: string, ...message: BroadcastMessage): number
    broadcastMessageToUserExcept(
        userId: string,
        excludeUuid: string,
        ...message: BroadcastMessage
    ): number
    broadcastMessageToUserConnection(
        userId: string,
        targetUuid: string,
        ...message: BroadcastMessage
    ): number
    broadcastMessageToChannel(channel: WsChannel, ...message: BroadcastMessage): boolean
}

// uWS ws.send: 1 sent, 0 buffered under backpressure (it still goes out), 2 dropped because the
// socket is over maxBackpressure. feat-124 (L9): 0 is delivered, so a slow tab is not taken for a
// missing one; a dropped event leaves the client out of step, so the connection is ended with 1013
// (as sendJson does for replies) and the client reconnects and resyncs.
const SEND_DROPPED = 2

// feat-128 (N3): events a client can lose without falling out of step. A stream token is a
// preview: support_chat_complete carries the whole reply, so a dropped token only leaves a gap in
// the preview. Ending the connection there would abort the run (onClose cancels it) and lose the
// reply already paid for; the final event, when dropped, still ends the connection.
const PREVIEW_EVENTS: ReadonlySet<BroadcastEventName> = new Set(['support_chat_token'])

const deliver = (
    connection: MyWebSocket,
    message: string,
    userId: string,
    event: BroadcastEventName,
): boolean => {
    const result = connection.send(message)
    if (result !== SEND_DROPPED) return true
    if (PREVIEW_EVENTS.has(event)) {
        logger.debug({ userId, event }, 'Broadcast preview event dropped by backpressure')
        return false
    }
    logger.warn(
        { userId, event, bufferedAmount: connection.getBufferedAmount() },
        'Broadcast dropped by backpressure, closing the connection',
    )
    connection.end(1013, 'Backpressure')
    return false
}

export const createBroadcastService = (options: ResponseCheckOptions): BroadcastService => {
    const checks = new Map<BroadcastEventName, ResponseCheck>()
    for (const event of BROADCAST_EVENT_NAMES) {
        const check = createResponseCheck(BroadcastEventSchemas[event], options)
        if (check !== null) checks.set(event, check)
    }

    // The JSON to send, or null when the event broke its contract (already logged).
    const serialize = (event: BroadcastEventName, payload: unknown): string | null => {
        const check = checks.get(event)
        const result = check?.(payload, { route: event, transport: 'broadcast' })
        if (result?.ok !== true) {
            logger.error({ event }, 'Broadcast event dropped: payload breaks its schema')
            return null
        }
        return makeBroadcastJson(event, 200, result.payload)
    }

    return {
        broadcastMessageToUser(userId: string, ...[event, payload]: BroadcastMessage): number {
            logger.info(`broadcastMessageToUser: ${userId} ${event}`)
            const message = serialize(event, payload)
            if (message === null) return 0
            let counter = 0
            wsConnectionRegistry.forEachConnection(userId, (userConnection) => {
                try {
                    if (deliver(userConnection, message, userId, event)) counter++
                } catch (error) {
                    logger.warn({ err: error }, `Error sending message to user ${userId}`)
                }
            })
            return counter
        },

        broadcastMessageToUserExcept(
            userId: string,
            excludeUuid: string,
            ...[event, payload]: BroadcastMessage
        ): number {
            logger.info(`broadcastMessageToUserExcept: ${userId} ${event} exclude: ${excludeUuid}`)
            const message = serialize(event, payload)
            if (message === null) return 0
            let counter = 0
            wsConnectionRegistry.forEachConnection(userId, (userConnection, uuid) => {
                if (uuid === excludeUuid) return
                try {
                    if (deliver(userConnection, message, userId, event)) counter++
                } catch (error) {
                    logger.warn({ err: error }, `Error sending message to user ${userId}`)
                }
            })
            return counter
        },

        broadcastMessageToUserConnection(
            userId: string,
            targetUuid: string,
            ...[event, payload]: BroadcastMessage
        ): number {
            logger.info(
                `broadcastMessageToUserConnection: ${userId} ${event} target: ${targetUuid}`,
            )
            const connection = wsConnectionRegistry.getConnection(userId, targetUuid)
            if (connection === undefined) {
                logger.warn(`Target WS connection not found for user ${userId}: ${targetUuid}`)
                return 0
            }
            const message = serialize(event, payload)
            if (message === null) return 0
            try {
                return deliver(connection, message, userId, event) ? 1 : 0
            } catch (error) {
                logger.warn(
                    { err: error },
                    `Error sending message to target connection ${targetUuid}`,
                )
                return 0
            }
        },

        broadcastMessageToChannel(
            channel: WsChannel,
            ...[event, payload]: BroadcastMessage
        ): boolean {
            logger.info({ channel, event }, 'broadcastMessageToChannel')
            const message = serialize(event, payload)
            if (message === null) return false
            return broadcastToChannel(channel, event, message)
        },
    }
}

export const broadcastService = createBroadcastService(responseValidationConfig)
