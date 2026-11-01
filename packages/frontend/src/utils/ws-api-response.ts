import { buildApiError } from '@/utils/websocket-types'
import type { ApiError, WebsocketMessage } from '@/utils/websocket-types'
import { hasResponseError } from '@/utils/response-normalizer'

export interface ApiResolveItem {
    resolve: (data: WebsocketMessage) => void
    reject: (error?: ApiError) => void
    timeout: number
}

/**
 * Settles the pending request whose event matches the response. An error
 * response (e.g. `service_unavailable` while Redis is down) rejects at once
 * instead of waiting for the client timeout; the connection is left alone.
 */
// The pending entry is stored under the request's event name.
export const hasPendingRequest = (
    pending: Partial<Record<string, ApiResolveItem>>,
    event: string,
): boolean => pending[event] !== undefined

export const settleApiResponse = (
    pending: Partial<Record<string, ApiResolveItem>>,
    data: WebsocketMessage,
): void => {
    const cb = pending[data.event]
    if (!cb) return

    window.clearTimeout(cb.timeout)
    Reflect.deleteProperty(pending, data.event)

    if (!hasResponseError(data)) {
        cb.resolve(data)
    } else {
        cb.reject(buildApiError(data))
    }
}
