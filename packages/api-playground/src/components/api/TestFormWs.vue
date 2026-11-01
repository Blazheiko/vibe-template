<script setup lang="ts">
import { toWsUrl } from '@/utils/api-path'
import { computed, onMounted, ref } from 'vue'
import type { ApiRoute } from '@/stores/api-doc'
import { validateJSON } from '@/utils/api-helpers'
import { formatResponseBody, scrollToResponse } from '@/utils/test-form-helpers'
import baseApi from '@/utils/base-api'
import { useWebSocketConnection } from '@/composables/useWebSocketConnection'
import { useApiSettingsStore } from '@/stores/api-settings'

interface Props {
    route: ApiRoute
    groupPrefix: string
    inModal?: boolean
}

const props = withDefaults(defineProps<Props>(), {
    inModal: false,
})

const apiSettingsStore = useApiSettingsStore()
const {
    websocketOpen,
    isConnected,
    isConnecting,
    connectionError: wsError,
    statusColor,
    statusTextColor,
    statusText,
    connectionStatus,
} = useWebSocketConnection()

const wsUrl = ref('')
const wsToken = ref('')
const body = ref('{\n  "message": "Hello WebSocket!"\n}')
const bodyError = ref('')
const isLoading = ref(false)

interface WsTestResult {
    success?: boolean
    error?: boolean
    status?: unknown
    statusText?: string
    responseTime?: number
    method?: string
    url?: string
    message?: string
    wsUrl?: string
    details?: string
    requestBody?: unknown
    data?: unknown
}

const testResult = ref<WsTestResult | null>(null)

onMounted(() => {
    const settings = apiSettingsStore.settings
    if (settings.baseUrl) {
        wsUrl.value = toWsUrl(settings.baseUrl)
    }
})

const validateBody = () => {
    const result = validateJSON(body.value)
    bodyError.value = result.error || ''
    return result
}

const connectWebSocket = () => {
    if (!wsUrl.value) {
        testResult.value = {
            success: false,
            error: true,
            message: 'WebSocket URL is required',
        }
        return
    }

    websocketOpen(wsUrl.value, wsToken.value)
    testResult.value = {
        success: true,
        message: 'Connecting to WebSocket...',
        url: wsUrl.value,
        status: 'Connecting',
    }
}

const sendWebSocketMessage = async () => {
    const bodyValidation = validateBody()

    if (!bodyValidation.isValid) {
        return
    }

    if (!isConnected.value) {
        testResult.value = {
            success: false,
            error: true,
            message: 'WebSocket is not connected. Please connect first.',
        }
        return
    }

    isLoading.value = true
    testResult.value = null
    const requestUrl = props.route.fullUrl ?? props.route.url

    try {
        const startTime = Date.now()
        const response = await baseApi.ws(
            requestUrl,
            bodyValidation.data as Record<string, unknown>,
        )
        const responseTime = Date.now() - startTime

        testResult.value = {
            success: true,
            status: response?.status || 200,
            statusText: 'WebSocket Response',
            data: response,
            responseTime,
            url: requestUrl,
            method: 'WebSocket',
            requestBody: bodyValidation.data,
            wsUrl: wsUrl.value,
        }
    } catch (error) {
        testResult.value = {
            success: false,
            status: 0,
            statusText: 'WebSocket Error',
            data: error instanceof Error ? error.message : 'Unknown error',
            responseTime: 0,
            error: true,
            url: requestUrl,
            method: 'WebSocket',
            requestBody: bodyValidation.data,
            wsUrl: wsUrl.value,
        }
    } finally {
        isLoading.value = false
        if (testResult.value) {
            await scrollToResponse('ws-response-body', 'ws-response-section')
        }
    }
}

const clearResult = () => {
    testResult.value = null
}

const responseBodyDisplay = computed(() => formatResponseBody(testResult.value?.data))
</script>

<template>
    <div
        id="ws-test-form"
        :class="['flex flex-col gap-5', inModal ? 'test-form-modal' : 'test-form-section flex-1']"
    >
        <div class="grid gap-5 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
            <section
                class="space-y-4 rounded-[0.8rem] border-2 border-slate-300 bg-white p-4 shadow-[0_18px_40px_rgba(15,23,42,0.12)] dark:border-slate-700 dark:bg-slate-900/70"
            >
                <div v-if="!inModal" class="flex items-center gap-2">
                    <svg
                        :class="[
                            'h-5 w-5 transition-colors duration-200',
                            {
                                'text-green-600 dark:text-green-400':
                                    connectionStatus === 'connected',
                                'text-yellow-600 dark:text-yellow-400':
                                    connectionStatus === 'connecting',
                                'text-red-600 dark:text-red-400': connectionStatus === 'error',
                                'text-gray-600 dark:text-gray-400':
                                    connectionStatus === 'disconnected',
                            },
                        ]"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                    >
                        <path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            stroke-width="2"
                            d="M8.111 16.404a5.5 5.5 0 017.778 0M12 20h.01m-7.08-7.071c3.904-3.905 10.236-3.905 14.141 0M1.394 9.393c5.857-5.857 15.355-5.857 21.213 0"
                        ></path>
                    </svg>
                    <h5 class="font-semibold text-gray-900 dark:text-gray-100">
                        WebSocket Testing
                    </h5>
                </div>

                <div class="grid gap-3 md:grid-cols-3">
                    <div
                        class="rounded-[0.65rem] border border-slate-300 bg-slate-100 p-3 shadow-[0_8px_18px_rgba(15,23,42,0.08)] dark:bg-slate-800/90"
                    >
                        <div
                            class="text-[11px] uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400"
                        >
                            Route
                        </div>
                        <div
                            class="mt-1 break-all text-sm font-semibold text-slate-900 dark:text-slate-100"
                        >
                            {{ route.url }}
                        </div>
                    </div>
                    <div
                        class="rounded-[0.65rem] border border-slate-300 bg-slate-100 p-3 shadow-[0_8px_18px_rgba(15,23,42,0.08)] dark:bg-slate-800/90"
                    >
                        <div
                            class="text-[11px] uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400"
                        >
                            Transport
                        </div>
                        <div class="mt-1 text-sm font-semibold text-slate-900 dark:text-slate-100">
                            Persistent socket
                        </div>
                    </div>
                    <div
                        class="rounded-[0.65rem] border border-slate-300 bg-slate-100 p-3 shadow-[0_8px_18px_rgba(15,23,42,0.08)] dark:bg-slate-800/90"
                    >
                        <div
                            class="text-[11px] uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400"
                        >
                            Connection
                        </div>
                        <div
                            class="mt-1 flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100"
                        >
                            <span :class="['h-2 w-2 rounded-full', statusColor]"></span>
                            {{ statusText }}
                        </div>
                    </div>
                </div>

                <div
                    class="rounded-[0.8rem] border-2 border-slate-300 bg-slate-100 p-4 shadow-[0_16px_34px_rgba(15,23,42,0.10)] dark:border-slate-700 dark:bg-slate-800/70"
                >
                    <div class="mb-3 flex items-center justify-between gap-3">
                        <h6 class="font-medium text-gray-700 dark:text-gray-300">
                            WebSocket Connection
                        </h6>
                        <span :class="['text-sm font-medium', statusTextColor]">{{
                            statusText
                        }}</span>
                    </div>

                    <div class="space-y-3">
                        <div>
                            <label
                                class="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300"
                                >WebSocket URL</label
                            >
                            <input
                                v-model="wsUrl"
                                type="text"
                                placeholder="ws://localhost:8080/api/websocket"
                                :disabled="isConnected || isConnecting"
                                class="w-full rounded-[0.65rem] border-2 border-slate-400 bg-white shadow-[inset_0_1px_0_rgba(255,255,255,0.5)] px-3 py-2 text-sm text-gray-900 outline-none transition focus:border-transparent focus:ring-2 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700 dark:text-white disabled:opacity-50"
                            />
                        </div>

                        <div>
                            <label
                                class="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300"
                            >
                                Auth Token
                                <span class="text-xs font-normal text-gray-500 dark:text-gray-400"
                                    >(Sec-WebSocket-Protocol)</span
                                >
                            </label>
                            <input
                                v-model="wsToken"
                                type="text"
                                placeholder="Paste token from login/init response"
                                :disabled="isConnected || isConnecting"
                                class="w-full rounded-[0.65rem] border-2 border-slate-400 bg-white shadow-[inset_0_1px_0_rgba(255,255,255,0.5)] px-3 py-2 text-sm text-gray-900 outline-none transition focus:border-transparent focus:ring-2 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700 dark:text-white disabled:opacity-50"
                            />
                        </div>

                        <div class="flex flex-wrap gap-2">
                            <button
                                type="button"
                                :disabled="isConnected || isConnecting || !wsUrl || !wsToken"
                                class="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-[0.65rem] bg-blue-700 shadow-[0_14px_26px_rgba(29,78,216,0.28)] px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
                                @click="connectWebSocket"
                            >
                                <svg
                                    v-if="isConnecting"
                                    class="h-4 w-4 animate-spin"
                                    fill="none"
                                    stroke="currentColor"
                                    viewBox="0 0 24 24"
                                >
                                    <path
                                        stroke-linecap="round"
                                        stroke-linejoin="round"
                                        stroke-width="2"
                                        d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                                    ></path>
                                </svg>
                                <svg
                                    v-else
                                    class="h-4 w-4"
                                    fill="none"
                                    stroke="currentColor"
                                    viewBox="0 0 24 24"
                                >
                                    <path
                                        stroke-linecap="round"
                                        stroke-linejoin="round"
                                        stroke-width="2"
                                        d="M13 10V3L4 14h7v7l9-11h-7z"
                                    ></path>
                                </svg>
                                {{ isConnecting ? 'Connecting...' : 'Connect' }}
                            </button>
                            <button
                                type="button"
                                class="inline-flex min-h-[44px] items-center justify-center rounded-[0.65rem] bg-slate-700 shadow-[0_14px_26px_rgba(15,23,42,0.18)] px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-700 focus:outline-none focus:ring-2 focus:ring-slate-500"
                                @click="clearResult"
                            >
                                Clear
                            </button>
                        </div>

                        <div
                            v-if="wsError"
                            class="rounded-[0.7rem] border-2 border-red-300 bg-red-100 p-3 shadow-[0_10px_22px_rgba(185,28,28,0.12)] dark:border-red-900 dark:bg-red-950/30"
                        >
                            <p class="text-sm text-red-700 dark:text-red-300">{{ wsError }}</p>
                        </div>
                    </div>
                </div>

                <form class="space-y-4" @submit.prevent="sendWebSocketMessage">
                    <div>
                        <label
                            class="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300"
                            >Message Body (JSON)</label
                        >
                        <textarea
                            v-model="body"
                            rows="12"
                            placeholder='{"key": "value"}'
                            class="min-h-[240px] w-full rounded-[0.7rem] border-2 border-slate-400 bg-white shadow-[inset_0_1px_0_rgba(255,255,255,0.5)] px-4 py-3 font-mono text-sm text-gray-900 outline-none transition focus:border-transparent focus:ring-2 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-700 dark:text-white"
                            :class="{ 'json-invalid': bodyError, 'json-valid': !bodyError && body }"
                            @input="validateBody"
                        ></textarea>
                        <div v-if="bodyError" class="json-error-message">
                            JSON Error: {{ bodyError }}
                        </div>
                    </div>

                    <button
                        type="submit"
                        :disabled="isLoading || !isConnected"
                        class="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-[0.65rem] bg-green-700 shadow-[0_14px_26px_rgba(21,128,61,0.28)] px-4 py-2 text-sm font-medium text-white transition hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-green-500 disabled:opacity-50"
                    >
                        <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path
                                stroke-linecap="round"
                                stroke-linejoin="round"
                                stroke-width="2"
                                d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"
                            ></path>
                        </svg>
                        {{ isLoading ? 'Sending...' : 'Send Message' }}
                    </button>
                </form>
            </section>

            <section
                id="ws-response-section"
                class="space-y-4 rounded-[0.8rem] border-2 border-slate-300 bg-slate-100 p-4 shadow-[0_18px_40px_rgba(15,23,42,0.12)] dark:border-slate-700 dark:bg-slate-950/70"
            >
                <div class="border-b border-slate-200 pb-3 dark:border-slate-700">
                    <p
                        class="text-xs uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400"
                    >
                        Response
                    </p>
                    <p class="text-sm text-slate-600 dark:text-slate-300">
                        Connection state, message delivery and returned payload.
                    </p>
                </div>

                <div
                    v-if="!testResult"
                    class="flex min-h-[320px] items-center justify-center rounded-[0.8rem] border-2 border-dashed border-slate-400 bg-white p-6 shadow-[0_14px_28px_rgba(15,23,42,0.10)] text-center dark:border-slate-700 dark:bg-slate-900/40"
                >
                    <div>
                        <p class="text-sm font-medium text-slate-700 dark:text-slate-200">
                            No WebSocket output yet
                        </p>
                        <p class="mt-2 text-sm text-slate-500 dark:text-slate-400">
                            Connect first, then send a message to inspect the result.
                        </p>
                    </div>
                </div>

                <template v-else>
                    <div
                        :class="[
                            'rounded-[0.8rem] border-2 p-4 shadow-[0_16px_34px_rgba(15,23,42,0.10)]',
                            testResult.error
                                ? 'border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/30'
                                : 'border-cyan-200 bg-cyan-50 dark:border-cyan-900 dark:bg-cyan-950/30',
                        ]"
                    >
                        <div class="flex flex-wrap items-center gap-3">
                            <span class="text-lg font-semibold"
                                >{{ testResult.status || 0 }}
                                {{ testResult.statusText || '' }}</span
                            >
                            <span
                                class="rounded-full bg-white/80 px-3 py-1 text-xs font-medium text-slate-700 dark:bg-slate-900/80 dark:text-slate-200"
                            >
                                {{ testResult.responseTime || 0 }}ms
                            </span>
                            <span class="text-sm text-slate-600 dark:text-slate-300"
                                >{{ testResult.method }} {{ testResult.url }}</span
                            >
                        </div>
                        <p
                            v-if="testResult.message"
                            class="mt-3 text-sm text-slate-700 dark:text-slate-200"
                        >
                            {{ testResult.message }}
                        </p>
                        <p
                            v-if="testResult.wsUrl"
                            class="mt-2 break-all text-xs text-slate-600 dark:text-slate-300"
                        >
                            Socket: {{ testResult.wsUrl }}
                        </p>
                        <p
                            v-if="testResult.details"
                            class="mt-2 whitespace-pre-wrap text-xs text-slate-600 dark:text-slate-300"
                        >
                            {{ testResult.details }}
                        </p>
                    </div>

                    <details
                        class="rounded-[0.75rem] border-2 border-slate-300 bg-white dark:border-slate-700 dark:bg-slate-900/70"
                        open
                    >
                        <summary
                            class="cursor-pointer px-4 py-3 text-sm font-medium text-slate-700 dark:text-slate-200"
                        >
                            Message snapshot
                        </summary>
                        <div class="border-t border-slate-200 px-4 py-4 dark:border-slate-700">
                            <h6
                                class="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400"
                            >
                                Sent payload
                            </h6>
                            <pre
                                class="overflow-x-auto rounded-[0.7rem] bg-slate-950 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] text-xs text-slate-100"
                            ><code>{{ JSON.stringify(testResult.requestBody, null, 2) }}</code></pre>
                        </div>
                    </details>

                    <div id="ws-response-body">
                        <h6
                            class="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400"
                        >
                            Response body
                        </h6>
                        <pre
                            class="max-h-[520px] overflow-auto rounded-[0.8rem] bg-slate-950 p-4 shadow-md text-sm text-slate-100"
                        ><code>{{ responseBodyDisplay }}</code></pre>
                    </div>
                </template>
            </section>
        </div>
    </div>
</template>
