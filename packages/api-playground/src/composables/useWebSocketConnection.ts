// src/composables/useWebSocketConnection.ts
import { useIntervalFn, useWebSocket } from '@vueuse/core'
import { ref, computed } from 'vue'
import { useEventBus } from '@/utils/event-bus'
import { classifyWsMessage } from 'shared/ws-client'

export type WebsocketPayload = Record<string, unknown>

export interface WebsocketMessage {
    event: string
    status: number
    payload: WebsocketPayload
    timestamp?: number
}

// Interfaces for API resolve
interface ApiResolveItem {
    resolve: (data: WebsocketMessage) => void
    reject: (error?: ApiError) => void
    timeout: number
}

interface ApiError {
    status?: number | string
    message?: string
    messages?: string[]
}

interface SendPayload {
    event: string
    timestamp: number
    payload: Record<string, unknown>
}

// ============================================================================
// SINGLETON STATE - Created once on first module import
// ============================================================================

const eventBus = useEventBus()
// WebSocket state (created once)
const wsUrl = ref<string>('')
const pendingWsUrl = ref<string>('')
const pendingWsToken = ref<string>('')
const isInitialized = ref(false)
const connectionError = ref<string | null>(null)
const lastMessage = ref<WebsocketMessage | null>(null)
// Mutable array passed to vueuse by reference so token updates are reflected
// in the next WebSocket() construction without recreating the composable.
const wsProtocols: string[] = ['']

// API resolve for handling responses (created once)
const apiResolve = ref<Partial<Record<string, ApiResolveItem>>>({})
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

// Service events handling
const service = (data: WebsocketMessage): void => {
    const serviceHandlers: Partial<Record<string, (payload: WebsocketPayload) => void>> = {
        pong: () => {
            console.log('Pong received')
        },
        connection_established: (payload: WebsocketPayload) => {
            isInitialized.value = true
            console.log('connection_established', payload)
        },
        connection_closed: () => {
            console.log('Server requested connection close')
        },
    }

    const handlerName = data.event.split(':')[1] as string | undefined
    if (handlerName === undefined) return
    serviceHandlers[handlerName]?.(data.payload)
}

// Broadcast events handling
const processBroadcast = (message: WebsocketMessage): void => {
    console.log('processBroadcast', message)
    lastMessage.value = message
    eventBus.emit('broadcast', message)
}

// Service error handling
const handleServiceError = (data: WebsocketMessage): void => {
    if (data.status === 4001) {
        console.warn('Token expired or invalid:', data.payload.message)
    }
}

let reconnectTimeout: number | null = null

const clearReconnectTimeout = () => {
    if (reconnectTimeout !== null) {
        clearTimeout(reconnectTimeout)
        reconnectTimeout = null
    }
}

// Handle WebSocket close event
const handleWebSocketClose = (event: CloseEvent): void => {
    console.log(`WebSocket closed with code: ${event.code}, reason: ${event.reason}`)
    resetApiResolve()

    // Clear any pending reconnect attempts to prevent multiple reconnection timers
    clearReconnectTimeout()

    // Code 4001: Unauthorized
    if (event.code === 4001) {
        console.warn('WebSocket closed due to authentication error (4001)')
        eventBus.emit('unauthorized')
        websocketClose()
        return
    }

    // Codes 4000-4099: Cannot reconnect
    if (event.code >= 4000 && event.code < 4100) {
        console.error(`WebSocket closed with code ${event.code}. Reconnection is not allowed.`)
        websocketClose()
        return
    }

    // For other codes, attempt to reconnect after delay
    if (event.code !== 1000) {
        connectionError.value = `Connection closed: ${event.reason || `code ${event.code}`}`
        console.log('WebSocket will attempt to reconnect in 5 seconds')
        reconnectTimeout = window.setTimeout(() => {
            reconnectTimeout = null
            console.log('Attempting to reconnect...')
            open()
        }, 5000)
    }
}

// API response handling
const messageHandler = (data: WebsocketMessage): void => {
    console.log('message handler')
    const cb = apiResolve.value[data.event]
    if (!cb) return

    window.clearTimeout(cb.timeout)
    Reflect.deleteProperty(apiResolve.value, data.event)

    lastMessage.value = data

    const statusCode =
        typeof data.status === 'string' ? Number.parseInt(data.status, 10) : data.status

    if (Number.isFinite(statusCode) && statusCode >= 200 && statusCode < 300) {
        cb.resolve(data)
    } else {
        cb.reject({
            status: data.status,
            message: data.payload.message as string | undefined,
            messages: data.payload.messages as string[] | undefined,
        })
    }
}

// Incoming message handler
const handleMessage = async (messageData: string | Blob | ArrayBuffer) => {
    try {
        if (messageData instanceof Blob) {
            messageData = await messageData.text()
        } else if (messageData instanceof ArrayBuffer) {
            messageData = new TextDecoder().decode(messageData)
        }

        if (typeof messageData !== 'string') {
            console.error('Unsupported WS message payload type')
            return
        }

        console.log('onmessage: ', messageData)
        const data: unknown = JSON.parse(messageData)
        if (!validateMessage(data)) {
            console.error('Invalid message format:', data)
            return
        }

        switch (classifyWsMessage(data.event, apiResolve.value[data.event] !== undefined)) {
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
    }
}

// ============================================================================
// WEBSOCKET INSTANCE - Created once on module load
// ============================================================================

const { status, send, close, open, ws } = useWebSocket(wsUrl, {
    immediate: false,
    autoConnect: false,
    protocols: wsProtocols,
    heartbeat: {
        message: 'ping',
        responseMessage: 'pong',
        // @vueuse/core 15 replaced `interval` with a scheduler. `immediate: false`:
        // useWebSocket resumes it on connect; a free-running interval's pong
        // timeout could close a socket that is still in its handshake.
        scheduler: (cb) => useIntervalFn(cb, 10000, { immediate: false }),
        pongTimeout: 5000,
    },
    onConnected() {
        console.log('WebSocket connected')
        isInitialized.value = true
        connectionError.value = null
        if (ws.value) {
            ws.value.binaryType = 'arraybuffer'
        }
    },
    onDisconnected(_, event) {
        console.log('WebSocket disconnected', event)
        isInitialized.value = false
        handleWebSocketClose(event)
    },
    onError(_, event) {
        console.error('WebSocket error:', event)
        connectionError.value = 'Connection error occurred'
    },
    onMessage(_, event) {
        void handleMessage(event.data as string | Blob | ArrayBuffer)
    },
})

// ============================================================================
// PUBLIC API - Methods for working with WebSocket
// ============================================================================

// Send messages
// There is no queue: without an open connection the message is not sent, and the
// caller learns it from the return value (code-issues item 64).
const sendMessage = (data: SendPayload): boolean => {
    if (status.value === 'OPEN') {
        send(JSON.stringify(data))
        return true
    }
    console.error('WebSocket is not connected: message not sent', data.event)
    return false
}

// API method — route is used directly as the event name (full path, e.g. 'api/ws/test')
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

        const event = route
        const timestamp = Date.now()
        if (apiResolve.value[event]) {
            console.error('Request already in progress')
            reject(new Error('Request already in progress'))
            return
        }

        sendMessage({
            event: event,
            timestamp,
            payload,
        })
        apiResolve.value[event] = {
            resolve,
            reject,
            timeout: window.setTimeout(() => {
                Reflect.deleteProperty(apiResolve.value, event)
                reject(new Error('Request timeout'))
            }, TIMEOUT_API),
        }
    })
}

const websocketClose = () => {
    console.log('websocketClose')

    clearReconnectTimeout()
    close()

    isInitialized.value = false
    resetApiResolve()
}

const resetApiResolve = () => {
    console.log('resetApiResolve')
    Object.values(apiResolve.value).forEach((item) => {
        if (item === undefined) return
        window.clearTimeout(item.timeout)
        item.reject(new Error('WebSocket connection reset'))
    })
    apiResolve.value = {}
}

const setPendingWs = (url: string, token: string) => {
    pendingWsUrl.value = url
    pendingWsToken.value = token
}

const websocketOpen = (url: string, token: string) => {
    console.log('websocketOpen', url)

    clearReconnectTimeout()
    connectionError.value = null

    wsProtocols[0] = token

    wsUrl.value = url
    open()
}

// Connection state
const isConnected = computed(() => status.value === 'OPEN')
const isConnecting = computed(() => status.value === 'CONNECTING')
const isDisconnected = computed(() => status.value === 'CLOSED')

// Derived UI state
const connectionStatus = computed(() => {
    if (isConnecting.value) return 'connecting'
    if (isConnected.value) return 'connected'
    if (connectionError.value) return 'error'
    return 'disconnected'
})

const statusColor = computed(() => {
    switch (connectionStatus.value) {
        case 'connected':
            return 'bg-green-500'
        case 'connecting':
            return 'bg-yellow-500'
        case 'error':
            return 'bg-red-500'
        default:
            return 'bg-gray-400'
    }
})

const statusTextColor = computed(() => {
    switch (connectionStatus.value) {
        case 'connected':
            return 'text-green-600 dark:text-green-400'
        case 'connecting':
            return 'text-yellow-600 dark:text-yellow-400'
        case 'error':
            return 'text-red-600 dark:text-red-400'
        default:
            return 'text-gray-600 dark:text-gray-400'
    }
})

const statusText = computed(() => {
    switch (connectionStatus.value) {
        case 'connected':
            return 'Connected'
        case 'connecting':
            return 'Connecting...'
        case 'error':
            return 'Error'
        default:
            return 'Disconnected'
    }
})

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
        connectionError,
        lastMessage,
        wsUrl,
        pendingWsUrl,
        pendingWsToken,

        // Computed UI helpers
        connectionStatus,
        statusColor,
        statusTextColor,
        statusText,

        // Methods
        sendMessage,
        websocketApi,
        websocketClose,
        websocketOpen,
        setPendingWs,

        // Raw WebSocket for compatibility
        ws,
    }
}
