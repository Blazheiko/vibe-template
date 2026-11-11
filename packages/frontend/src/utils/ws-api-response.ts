import { buildApiError } from '@/utils/websocket-types'
import type { ApiError, WebsocketMessage } from '@/utils/websocket-types'
import { hasResponseError } from '@/utils/response-normalizer'

export interface ApiResolveItem {
    resolve: (data: WebsocketMessage) => void
    reject: (error?: ApiError) => void
    timeout: number
}

/**
 * The id a request is sent with and its reply comes back with (ADR 0006, Д-WS1, feat-180).
 * Several requests of one event can be pending at once: each waits under its own id.
 */
export const newRequestId = (): string =>
    // randomUUID is missing in older runtimes and outside secure contexts.
    typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`

/** Whether a message is the reply to a pending request: it carries that request's id. */
export const hasPendingRequest = (
    pending: Partial<Record<string, ApiResolveItem>>,
    message: Pick<WebsocketMessage, 'id'>,
): boolean => message.id !== undefined && pending[message.id] !== undefined

/**
 * Settles the pending request whose id the reply carries. An error reply (e.g.
 * `service_unavailable` while Redis is down) rejects at once instead of waiting for the
 * client timeout; the connection is left alone. A reply without a pending id settles nothing.
 */
export const settleApiResponse = (
    pending: Partial<Record<string, ApiResolveItem>>,
    data: WebsocketMessage,
): void => {
    if (data.id === undefined) return
    const cb = pending[data.id]
    if (!cb) return

    window.clearTimeout(cb.timeout)
    Reflect.deleteProperty(pending, data.id)

    if (!hasResponseError(data)) {
        cb.resolve(data)
    } else {
        cb.reject(buildApiError(data))
    }
}
