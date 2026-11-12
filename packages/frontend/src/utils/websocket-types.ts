// The client-side errors of WebSocket requests. The message envelope itself is shared with the
// server and the playground: `WsReplyEnvelope` / `WsBroadcastEnvelope` of shared/ws-client
// (feat-184).
import type { WsReplyEnvelope } from 'shared/ws-client'
import { normalizeResponseError } from './response-normalizer'
import type { ErrorCode } from 'shared/errors'

export type WebsocketErrorMessages = Record<string, unknown> | string[] | string

/**
 * A request that got no answer (the client timeout, or the connection dropped while it was
 * pending). The server may well have accepted it, so the caller must not treat it as a
 * refusal and, for a message, must check before sending it again.
 */
export class WsDeliveryUnknownError extends Error {
    override readonly name = 'WsDeliveryUnknownError'
}

export const isDeliveryUnknown = (error: unknown): error is WsDeliveryUnknownError =>
    error instanceof WsDeliveryUnknownError

export interface ApiError {
    code?: ErrorCode
    transportCode?: number
    status?: number | string
    message?: string
    messages?: WebsocketErrorMessages
}

export const buildApiError = (data: WsReplyEnvelope): ApiError => {
    const normalizedError = normalizeResponseError(data, 'WebSocket request failed')
    return {
        code: normalizedError.code,
        transportCode: normalizedError.transportCode,
        status: normalizedError.status,
        message: normalizedError.message,
        messages: normalizedError.messages,
    }
}
