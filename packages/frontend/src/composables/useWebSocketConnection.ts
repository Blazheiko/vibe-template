// src/composables/useWebSocketConnection.ts
import { useWebSocket } from '@vueuse/core'
import { createHeartbeatOptions } from '@/utils/websocket-heartbeat'
import { ref, computed, toRaw } from 'vue'
import { WsDeliveryUnknownError } from '@/utils/websocket-types'
import type { WebsocketMessage } from '@/utils/websocket-types'
import {
    getResponseMessage,
    getTransportCode,
    hasResponseError,
    isUnauthorizedError,
} from '@/utils/response-normalizer'
import { useBroadcastHandler } from '@/composables/useBroadcastHandler'
import { reportValidationFailure } from '@/utils/sentry-payload-summary'
import { useEventBus } from '@/utils/event-bus'
import { mainApi } from '@/utils/api'
import { getCurrentAppType } from '@/utils/app-type'
import { sentryService } from '@/utils/sentry-service'
import { classifyWsMessage, type WsServiceHandlerName } from 'shared/ws-client'
import {
    hasPendingRequest,
    newRequestId,
    settleApiResponse,
    type ApiResolveItem,
} from '@/utils/ws-api-response'
import { buildWsEvent } from '@/utils/ws-event'
import { resolveWebSocketCloseAction } from '@/utils/websocket-close'

interface SendPayload {
    event: string
    /** Request id, echoed by the reply (ADR 0006). */
    id?: string
    timestamp: number
    payload: Record<string, unknown>
}

// ============================================================================
// SINGLETON STATE - Created once on first module import
// ============================================================================

// Lazy-loaded broadcast handler (created when first needed)
let broadcastHandler: ReturnType<typeof useBroadcastHandler> | null = null
const getBroadcastHandler = () => {
    broadcastHandler ??= useBroadcastHandler()
    return broadcastHandler
}

const eventBus = useEventBus()
// WebSocket state (created once)
const wsUrl = ref<string>('')
const isInitialized = ref(false)
// Mutable array passed to vueuse by reference — mutate before reconnecting so
// the next WebSocket is constructed with the updated Sec-WebSocket-Protocol value.
const wsProtocols: string[] = ['', 'app-web']

// API resolve for handling responses (created once)
// Pending requests by request id.
const apiResolve = ref<Record<string, ApiResolveItem>>({})
const TIMEOUT_API = 10000

// ============================================================================
// INTERNAL FUNCTIONS - Created once on module load
// ============================================================================

// Message validation function
const validateMessage = (message: unknown): message is WebsocketMessage => {
    if (typeof message !== 'object' || message === null) return false
    const { event, payload } = message as { event?: unknown; payload?: unknown }
    return typeof event === 'string' && (!payload || typeof payload === 'object')
}

// Service events of the server (shared/ws-client, ADR 0006): one handler for each of them but
// `service:error`, which handleServiceError takes. The map must name every one.
const serviceHandlers: Record<WsServiceHandlerName, (message: WebsocketMessage) => void> = {
    connection_established: (message) => {
        isInitialized.value = true
        console.log('connection_established', message)
    },
}

const isServiceHandlerName = (name: string): name is WsServiceHandlerName =>
    Object.prototype.hasOwnProperty.call(serviceHandlers, name)

const service = (data: WebsocketMessage): void => {
    const handlerName = data.event.slice('service:'.length)
    if (isServiceHandlerName(handlerName)) serviceHandlers[handlerName](data)
}

// Broadcast events handling
const processBroadcast = (message: WebsocketMessage): void => {
    console.log('processBroadcast', message)
    // Use lazy-loaded broadcast handler from composable
    const { handleBroadcast } = getBroadcastHandler()
    handleBroadcast(message)
}

// Service error handling
const handleServiceError = (data: WebsocketMessage): void => {
    if (getTransportCode(data) === 4001) {
        console.warn(
            'Token expired or invalid:',
            getResponseMessage(data, 'Token expired or invalid'),
        )
        // Don't call unauthorized() here - let handleWebSocketClose handle it
        // to avoid duplicate reconnection attempts when server closes connection with code 4001
    }
}

let isUpdatingWsToken = false
let reconnectTimeout: number | null = null
// feat-151: sockets the client closed itself (a sign-out, or an old socket replaced by a new
// one). vueuse reports the close of every socket through onDisconnected, also after it
// stopped being the current one; for these it is not a lost connection.
const retiredSockets = new WeakSet<WebSocket>()
// Whether the current socket reached "open"; a refused upgrade closes without it.
let connectionOpened = false
let handshakeFailuresInARow = 0

const clearReconnectTimeout = () => {
    if (reconnectTimeout !== null) {
        clearTimeout(reconnectTimeout)
        reconnectTimeout = null
    }
}

const unauthorized = async () => {
    console.warn('WebSocket closed due to authentication error (4001)')
    if (isUpdatingWsToken) {
        console.log('Token update already in progress, skipping...')
        return
    }

    // Clear any pending reconnect attempts
    clearReconnectTimeout()

    isUpdatingWsToken = true
    const { data, error } = await mainApi.updateWsToken()
    isUpdatingWsToken = false
    if (error) {
        console.error('Error updating WebSocket token:', error)
        if (isUnauthorizedError(data, error.transportCode)) {
            eventBus.emit('unauthorized')
            websocketClose()
        } else {
            // Retry after 5 seconds
            reconnectTimeout = window.setTimeout(() => {
                reconnectTimeout = null
                void unauthorized()
            }, 5000)
        }
    } else if (
        data !== null &&
        !hasResponseError(data) &&
        data.status === 'ok' &&
        data.wsUrl &&
        data.wsToken
    ) {
        console.log('WebSocket token updated')
        websocketOpen(data.wsUrl, data.wsToken)
    } else {
        // Retry after 5 seconds
        reconnectTimeout = window.setTimeout(() => {
            reconnectTimeout = null
            void unauthorized()
        }, 5000)
    }
}

// Handle WebSocket close event
const handleWebSocketClose = (socket: WebSocket, event: CloseEvent): void => {
    console.log(`WebSocket closed with code: ${event.code}, reason: ${event.reason}`)

    // A retired socket: its requests were rejected and its timers cleared when it was
    // retired. The requests pending now, the reconnect timer and the "opened" flag belong to
    // the socket that replaced it (or to nobody, after a sign-out).
    if (retiredSockets.has(socket)) {
        const ignored = resolveWebSocketCloseAction(event.code, false, 0, true)
        console.log(`WebSocket close of a retired socket: ${ignored.kind}`)
        return
    }

    resetApiResolve()

    // Clear any pending reconnect attempts to prevent multiple reconnection timers
    clearReconnectTimeout()

    const wasOpened = connectionOpened
    connectionOpened = false
    handshakeFailuresInARow = wasOpened ? 0 : handshakeFailuresInARow + 1
    const action = resolveWebSocketCloseAction(event.code, wasOpened, handshakeFailuresInARow)
    if (action.kind === 'ignore') return

    // 4001, or the server refused the upgrade (no live session): refresh the token
    if (action.kind === 'refresh-token') {
        console.warn(`WebSocket closed due to authentication error (${event.code})`)
        if (action.delayMs === 0) {
            void unauthorized()
        } else {
            reconnectTimeout = window.setTimeout(() => {
                reconnectTimeout = null
                void unauthorized()
            }, action.delayMs)
        }
        return
    }

    // Codes 4000-4099: Cannot reconnect
    if (action.kind === 'stop') {
        console.error(`WebSocket closed with code ${event.code}. Reconnection is not allowed.`)
        websocketClose()
        return
    }

    // For other codes, attempt to reconnect after delay
    console.log(`WebSocket will attempt to reconnect in ${String(action.delayMs / 1000)} seconds`)
    reconnectTimeout = window.setTimeout(() => {
        reconnectTimeout = null
        console.log('Attempting to reconnect...')
        open()
    }, action.delayMs)
}

// API response handling
const messageHandler = (data: WebsocketMessage): void => {
    console.log('message handler')
    settleApiResponse(apiResolve.value, data)
}

const handleMessage = async (messageData: string | Blob | ArrayBuffer) => {
    try {
        if (messageData instanceof Blob) {
            const ab = await messageData.arrayBuffer()
            messageData = new TextDecoder().decode(ab)
        } else if (messageData instanceof ArrayBuffer) {
            messageData = new TextDecoder().decode(messageData)
        }

        if (typeof messageData !== 'string') {
            console.error('Unsupported WS message payload type')
            reportValidationFailure('message', 'payload_type', messageData)
            return
        }

        console.log('onmessage: ', messageData)
        const data: unknown = JSON.parse(messageData)
        if (!validateMessage(data)) {
            console.error('Invalid message format:', data)
            reportValidationFailure('message', 'message_schema', data)
            return
        }

        switch (classifyWsMessage(data.event, hasPendingRequest(apiResolve.value, data))) {
            case 'service-error':
                handleServiceError(data)
                break
            case 'broadcast':
                processBroadcast(data)
                break
            case 'service':
                service(data)
                break
            case 'api':
                messageHandler(data)
                break
            case 'unknown':
                console.warn('WS message without a pending request:', data.event)
                break
        }
    } catch (error) {
        console.error('Error parsing message:', error)
        sentryService.captureException(error, {
            tags: {
                wsEvent: 'message',
            },
        })
    }
}

// ============================================================================
// WEBSOCKET INSTANCE - Created once on module load
// ============================================================================

const { status, send, close, open, ws } = useWebSocket(wsUrl, {
    immediate: false,
    protocols: wsProtocols,
    // autoReconnect: {
    //     retries: -1,
    //     delay: 5000,
    //     onFailed() {
    //         console.error('WebSocket reconnection failed after maximum attempts')
    //     },
    // },
    heartbeat: createHeartbeatOptions(),
    onConnected() {
        console.log('WebSocket connected')
        connectionOpened = true
        handshakeFailuresInARow = 0
        isInitialized.value = true
        if (ws.value) {
            ws.value.binaryType = 'arraybuffer'
        }
        // Check for SW updates on each WS connection (covers reconnects after sleep/offline)
        if (import.meta.env.PROD && 'serviceWorker' in navigator) {
            navigator.serviceWorker
                .getRegistration()
                .then((reg) => {
                    if (reg) {
                        reg.update().catch(() => undefined)
                    }
                })
                .catch(() => undefined)
        }
    },
    onDisconnected(socket, event) {
        console.log('WebSocket disconnected', event)
        // Not for a retired socket: a new one may be connected by now.
        if (!retiredSockets.has(socket)) {
            isInitialized.value = false
        }
        // Handle close event with proper code checking
        handleWebSocketClose(socket, event)
    },
    onError(_, event) {
        console.error('WebSocket error:', event)
    },
    onMessage(_, event) {
        void handleMessage(event.data as string | Blob | ArrayBuffer)
    },
})

// ============================================================================
// PUBLIC API - Methods for working with WebSocket
// ============================================================================

// Send messages
const sendMessage = (data: SendPayload) => {
    if (status.value === 'OPEN') {
        send(JSON.stringify(data))
    } else {
        console.warn('WebSocket not connected, message queued')
    }
}

// Sends a request over the socket and resolves with the reply of the same event.
const websocketApi = async (
    route: string,
    payload: Record<string, unknown> = {},
): Promise<WebsocketMessage> => {
    return new Promise((resolve, reject) => {
        const isConnected = status.value === 'OPEN'
        if (!isConnected) {
            console.error('WebSocket not connected')
            reject(new Error('WebSocket not connected'))
            return
        }

        const event = buildWsEvent(route)
        // The reply carries this id back (ADR 0006): requests of one event do not wait in line.
        const id = newRequestId()

        sendMessage({
            event: event,
            id,
            timestamp: Date.now(),
            payload,
        })
        apiResolve.value[id] = {
            resolve,
            reject,
            timeout: window.setTimeout(() => {
                Reflect.deleteProperty(apiResolve.value, id)
                reject(new WsDeliveryUnknownError('Request timeout'))
            }, TIMEOUT_API),
        }
    })
}

/**
 * The current socket is closed by the client: its close event, when it arrives, is not a lost
 * connection. What belonged to it goes now — its pending requests and its "opened" flag —
 * so the event has nothing left to undo and the next socket starts clean.
 */
const retireCurrentSocket = (): void => {
    if (ws.value !== undefined) {
        // The raw socket: the one vueuse hands to onDisconnected.
        retiredSockets.add(toRaw(ws.value))
    }
    connectionOpened = false
    resetApiResolve()
}

const websocketClose = () => {
    console.log('websocketClose')

    // Clear any pending reconnect attempts
    clearReconnectTimeout()

    // Close the connection
    retireCurrentSocket()
    close()

    // Reset state
    isInitialized.value = false

    // Clear all pending API requests
    resetApiResolve()
}

const resetApiResolve = () => {
    console.log('resetApiResolve')
    Object.values(apiResolve.value).forEach((item) => {
        window.clearTimeout(item.timeout)
        item.reject(new WsDeliveryUnknownError('WebSocket connection reset'))
    })
    apiResolve.value = {}
}

const websocketOpen = (url: string, token: string) => {
    console.log('websocketOpen', url)

    clearReconnectTimeout()

    // A live socket is about to be replaced (a token refresh over an open connection):
    // vueuse closes it inside open(), and its close event arrives after the new one exists.
    retireCurrentSocket()

    // Update protocols before creating the connection — vueuse captured this
    // array by reference, so the next WebSocket() call will use the new value.
    wsProtocols[0] = token
    wsProtocols[1] = `app-${getCurrentAppType()}`

    const urlChanged = wsUrl.value !== url
    wsUrl.value = url

    if (urlChanged) {
        // vueuse's watch(urlRef, open) fires and handles the reconnect.
    } else {
        // URL is unchanged (token refreshed, same base URL) — trigger manually.
        open()
    }
}

// Connection state
const isConnected = computed(() => status.value === 'OPEN')
const isConnecting = computed(() => status.value === 'CONNECTING')
const isDisconnected = computed(() => status.value === 'CLOSED')

// ============================================================================
// EXPORTED COMPOSABLE - Uses JS module system as singleton
// ============================================================================

/**
 * WebSocket Connection Composable (Singleton)
 *
 * This composable uses JavaScript module system to ensure singleton behavior.
 * All code above executes only once on first module import, regardless of how
 * many times useWebSocketConnection is called.
 *
 * @returns Object with WebSocket connection methods and state
 */
export const useWebSocketConnection = () => {
    // Always return the same set of methods and state
    return {
        // State
        statusWebSocket: status,
        isConnected,
        isConnecting,
        isDisconnected,
        isInitialized,

        // Methods
        sendMessage,
        websocketApi,
        websocketClose,
        websocketOpen,
    }
}
