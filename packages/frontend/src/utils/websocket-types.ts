// Shapes of WebSocket messages and the client-side API error built from them.
import { normalizeResponseError } from './response-normalizer'
import type { ErrorCode } from 'shared/errors'

export type WebsocketPayload = Record<string, unknown>
export type WebsocketErrorMessages = Record<string, unknown> | string[] | string

interface WebsocketErrorPayload {
    code?: number | ErrorCode
    message?: string
    messages?: WebsocketErrorMessages
}

export interface WebsocketMessage {
    event: string
    status: number | string
    timestamp: number
    payload: WebsocketPayload
    // string covers ErrorCode as well as legacy codes.
    code?: number | string
    error?: WebsocketErrorPayload | null
}

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

export const buildApiError = (data: WebsocketMessage): ApiError => {
    const normalizedError = normalizeResponseError(data, 'WebSocket request failed')
    return {
        code: normalizedError.code,
        transportCode: normalizedError.transportCode,
        status: normalizedError.status,
        message: normalizedError.message,
        messages: normalizedError.messages,
    }
}
