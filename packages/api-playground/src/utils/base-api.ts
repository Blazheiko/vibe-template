import { apiUrl } from '@/utils/api-path'
import { useEventBus } from '@/utils/event-bus'
import { useApiSettingsStore } from '@/stores/api-settings'
import { normalizePath } from '@/utils/api-helpers'
import { redactHeaders } from './redact-headers'
import { useWebSocketConnection } from '@/composables/useWebSocketConnection'

type HttpResponse = Record<string, unknown>

interface ApiResponse<T> {
    data: T | null
    error: { message: string; code: number } | null
    status?: number
    statusText?: string
    headers?: Record<string, string>
}

interface ApiMethods {
    http: <T = HttpResponse>(
        method: string,
        route: string,
        body?: Record<string, unknown>,
        customHeaders?: Record<string, string>,
    ) => Promise<ApiResponse<T>>
    ws: <T = HttpResponse>(route: string, body?: Record<string, unknown>) => Promise<T | null>
}

/** The `http` call of the client, as a type, so code that takes it can be given a fake. */
export type SendHttp = ApiMethods['http']

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | (string & {})

interface RequestInit {
    method: HttpMethod
    headers: Record<string, string>
    body?: string
}

const eventBus = useEventBus()

const getApiSettings = () => useApiSettingsStore().settings

// Функция для проверки доступности сервера
const checkServerHealth = async (baseUrl: string): Promise<boolean> => {
    try {
        // The backend liveness route; there is no /health (feat-009 follow-up).
        const response = await fetch(apiUrl(baseUrl, 'ping'), {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(5000), // 5 секунд таймаут
        })
        return response.ok
    } catch {
        return false
    }
}

/** The JSON body of an answer, or null when it has none or it is not JSON. */
const readJsonBody = async (response: Response): Promise<unknown> => {
    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.toLowerCase().includes('json')) return null
    try {
        return (await response.json()) as unknown
    } catch {
        return null
    }
}

const messageOf = (body: unknown): string | undefined => {
    const message = (body as { message?: unknown } | null)?.message
    return typeof message === 'string' && message !== '' ? message : undefined
}

const api: ApiMethods = {
    http: async <T = HttpResponse>(
        method: HttpMethod,
        route: string,
        body: Record<string, unknown> = {},
        customHeaders: Record<string, string> = {},
    ): Promise<ApiResponse<T>> => {
        const apiSettings = getApiSettings()

        const baseHeaders: Record<string, string> = {
            'Content-Type': 'application/json',
        }

        const headersToAdd =
            Object.keys(apiSettings.globalHeaders).length > 0
                ? { ...baseHeaders, ...apiSettings.globalHeaders, ...customHeaders }
                : { ...baseHeaders, ...customHeaders }

        const init: RequestInit = {
            method,
            headers: headersToAdd,
        }

        if (method.toLowerCase() !== 'get' && method.toLowerCase() !== 'delete') {
            init.body = JSON.stringify(body)
        }

        try {
            let url = route
            if (route.startsWith('http')) {
                url = route
            } else if (route.startsWith('/')) {
                url = `${apiSettings.baseUrl}/${route.slice(1)}`
            } else {
                url = `${apiSettings.baseUrl}/${route}`
            }

            console.log('Making API request:', {
                method,
                url,
                headers: redactHeaders(headersToAdd),
                body: init.body,
            })

            const response = await fetch(url, init)
            const answered = {
                status: response.status,
                statusText: response.statusText,
                headers: Object.fromEntries(response.headers.entries()),
            }
            // The body, whatever the status: an error says why in it (`code`, `message`,
            // `reason` of a CSRF refusal). No body, or one that is not JSON, is null (feat-158).
            const data = await readJsonBody(response)

            if (response.ok) {
                return { data: data as T | null, error: null, ...answered }
            }

            if (response.status === 401) {
                eventBus.emit('unauthorized')
            }
            const message =
                messageOf(data) ??
                (response.status === 422
                    ? 'Validation Error'
                    : `HTTP error! status: ${String(response.status)}`)
            return {
                data: data as T | null,
                error: { code: response.status, message },
                ...answered,
            }
        } catch (error: unknown) {
            console.error('Network error:', error)

            let errorMessage = 'Network error. Please try again later.'
            let errorCode = 0

            if (error instanceof TypeError && error.message.includes('Failed to fetch')) {
                errorMessage =
                    `Failed to connect to server at ${apiSettings.baseUrl}. Please check:\n` +
                    '1. Server is running and accessible\n' +
                    '2. Base URL is correct in API settings\n' +
                    '3. CORS is properly configured on server\n' +
                    '4. Network connection is available\n' +
                    '5. Firewall is not blocking the connection'
                errorCode = -1
            } else if (error instanceof Error) {
                errorMessage = error.message
            }

            return {
                data: null,
                error: {
                    code: errorCode,
                    message: errorMessage,
                },
            }
        }
    },

    ws: async <T = HttpResponse>(
        route: string,
        body: Record<string, unknown> = {},
    ): Promise<T | null> => {
        const { websocketApi } = useWebSocketConnection()

        // A refused request or a timeout rejects (WsRequestError): turning it into a result
        // made the form show a failed request as a success (feat-158).
        const result = await websocketApi(normalizePath(route), body)
        return result as unknown as T
    },
}

export default api
export { checkServerHealth }
