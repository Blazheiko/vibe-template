// The WebSocket message envelope (ADR 0006): what the client sends and what the server answers,
// described once for the server and both clients (feat-184). The payload of a request and the
// data of a reply are typed by the WS contract of the event (`shared/contracts`); here they are
// generic. The heartbeat is not an envelope: it is the plain text `ping` → `pong`.

/** The error of a refused request (backend `createWsErrorEnvelope`). */
export interface WsErrorBody {
    /** An `ErrorCode` of `shared/errors`, e.g. `validation_failed`. */
    code: string
    message: string
    reason?: string
    details?: unknown
}

/** A request, client → server. */
export interface WsRequestEnvelope<TPayload = Record<string, unknown> | null> {
    /** The event under the API prefix, e.g. `api/support/support_chat`. */
    event: string
    /** The client's id of the request (1–64 characters), echoed by the reply. */
    id?: string
    timestamp: number
    payload: TPayload
}

/**
 * The HTTP status of the answer as text (`'200'`, or e.g. `'404'` when the route answered with a
 * business error in `data`), or `'error'` when the request was refused (`error` is set).
 */
export type WsReplyStatus = `${number}` | 'error'

/**
 * A reply to a request, server → client: the request's event and id, and either `data` (the
 * route's answer, a business error included) or `error` (the request was refused). The service
 * events (`service:connection_established`, `service:error`) come in the same envelope.
 */
export interface WsReplyEnvelope<TData = unknown> {
    event: string
    /** The `id` of the request this replies to, when it had one. */
    id?: string
    status: WsReplyStatus
    timestamp: number
    data: TData | null
    error: WsErrorBody | null
}

/** A broadcast, server → client: no id, no timestamp; the payload is typed by `BroadcastContracts`. */
export interface WsBroadcastEnvelope<TPayload = unknown> {
    event: `broadcast:${string}`
    status: number
    payload: TPayload
}

/** The `data` of `service:connection_established`. */
export interface WsConnectionEstablishedData {
    socket_id: string
    /** Seconds without traffic before the server treats the connection as idle. */
    activity_timeout: number
}

/** Anything the server sends as JSON. */
export type WsIncomingMessage = WsReplyEnvelope | WsBroadcastEnvelope

/** Whether a message is a broadcast; every other JSON message is a reply envelope. */
export const isWsBroadcast = (message: WsIncomingMessage): message is WsBroadcastEnvelope =>
    message.event.startsWith('broadcast:')
