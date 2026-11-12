// What the two WebSocket clients (the app and the API playground) agree on, with no Vue and no
// library behind it. The connections themselves are not here: the app's (heartbeat, token
// refresh, handshake back-off) and the playground's (a plain reconnect) differ on purpose.

export type WsMessageKind = 'service-error' | 'broadcast' | 'service' | 'api' | 'unknown'

/**
 * The service events the server sends (backend vendor/utils/network/ws-handlers.ts): a fixed set
 * of the transport, not routes (ADR 0006, decision 5). The heartbeat is not one of them: it is
 * the plain text `ping` → `pong`, outside JSON.
 */
export type WsServiceEvent = 'service:connection_established' | 'service:error'

/** The name after `service:` of a service event the client handles, e.g. `connection_established`. */
export type WsServiceHandlerName =
    Exclude<WsServiceEvent, 'service:error'> extends `service:${infer N}` ? N : never

/**
 * Routes an incoming WS message. An API response echoes the request event, which carries
 * the configured prefix (`api/...`, `v1/...`), so it is recognised by its pending request,
 * not by a hard-coded `api` prefix.
 */
export const classifyWsMessage = (event: string, isPending: boolean): WsMessageKind => {
    if (event === 'service:error') return 'service-error'
    if (event.startsWith('broadcast:')) return 'broadcast'
    if (event.startsWith('service:')) return 'service'
    return isPending ? 'api' : 'unknown'
}

/**
 * The prefix HTTP paths and WS request events live under (the backend's `API_PATH_PREFIX`):
 * slashes and spaces trimmed, `api` when nothing is left.
 */
export const normalizeApiPrefix = (raw: string | undefined): string => {
    const trimmed = (raw ?? '').trim().replace(/^\/+|\/+$/g, '')
    return trimmed === '' ? 'api' : trimmed
}

export {
    isWsBroadcast,
    type WsBroadcastEnvelope,
    type WsConnectionEstablishedData,
    type WsErrorBody,
    type WsIncomingMessage,
    type WsReplyEnvelope,
    type WsReplyStatus,
    type WsRequestEnvelope,
} from './envelope.js'
