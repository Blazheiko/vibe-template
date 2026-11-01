<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ApiRoute } from '@/stores/api-doc'
import { extractParameters, getDefaultRequestBody, validateJSON } from '@/utils/api-helpers'
import { formatResponseBody, scrollToResponse } from '@/utils/test-form-helpers'
import { wsHandoffOf } from '@/utils/load-test'
import { useLoadTest } from '@/composables/useLoadTest'
import { useWebSocketConnection } from '@/composables/useWebSocketConnection'

interface Props {
    route: ApiRoute
    groupPrefix: string
    inModal?: boolean
}

const props = withDefaults(defineProps<Props>(), {
    inModal: false,
})

const { setPendingWs } = useWebSocketConnection()

const parameters = computed(() => extractParameters(props.route.url))
const isBodyMethod = computed(() =>
    ['POST', 'PUT', 'PATCH'].includes(props.route.method.toUpperCase()),
)

const requestCount = ref(1)
const threadCount = ref(1)
const batchModeEnabled = ref(false)
const headers = ref('{\n  "Content-Type": "application/json"\n}')
const body = ref(getDefaultRequestBody(props.route.inputSchema))
const paramValues = ref<Record<string, string>>({})

const headersError = ref('')
const bodyError = ref('')
const copyCurlState = ref<'idle' | 'copied' | 'error'>('idle')

const { testResult, isLoading, progress, progressPercentage, run, clear } = useLoadTest({
    requestCount,
    threadCount,
    onSingleResponse: (outcome) => {
        const handoff = wsHandoffOf(outcome)
        if (handoff) setPendingWs(handoff.url, handoff.token)
    },
})

const responseBodyRaw = computed(() => {
    const value = testResult.value
    if (!value) return undefined
    return value.firstResult?.data ?? value.data
})

const responseBodyDisplay = computed(() => formatResponseBody(responseBodyRaw.value))

const validateHeaders = () => {
    const result = validateJSON(headers.value)
    headersError.value = result.error || ''
    return result
}

const validateBody = () => {
    const result = validateJSON(body.value)
    bodyError.value = result.error || ''
    return result
}

const buildUrl = () => {
    let url = props.route.fullUrl
    if (!url) throw new Error('fullUrl is not defined')

    Object.entries(paramValues.value).forEach(([key, value]) => {
        if (value) {
            url = url?.replace(`:${key}`, value)
        }
    })

    return url
}

const buildCurlCommand = () => {
    const headersValidation = validateHeaders()
    const bodyValidation = isBodyMethod.value ? validateBody() : { isValid: true, data: undefined }
    const finalUrl = buildUrl()
    const requestHeaders = headersValidation.data || { 'Content-Type': 'application/json' }

    const headerFlags = Object.entries(requestHeaders)
        .map(([key, value]) => `-H '${key}: ${String(value).replace(/'/g, "'\\''")}'`)
        .join(' ')

    const bodyFlag =
        isBodyMethod.value && bodyValidation.data !== undefined
            ? ` -d '${JSON.stringify(bodyValidation.data).replace(/'/g, "'\\''")}'`
            : ''

    return `curl -X ${props.route.method.toUpperCase()} '${finalUrl}' ${headerFlags}${bodyFlag}`.trim()
}

const copyCurl = async () => {
    try {
        await navigator.clipboard.writeText(buildCurlCommand())
        copyCurlState.value = 'copied'
    } catch {
        copyCurlState.value = 'error'
    } finally {
        window.setTimeout(() => {
            copyCurlState.value = 'idle'
        }, 1600)
    }
}

const sendRequest = async () => {
    const headersValidation = validateHeaders()
    const bodyValidation = isBodyMethod.value ? validateBody() : { isValid: true, data: undefined }

    if (!headersValidation.isValid || !bodyValidation.isValid) {
        return
    }

    await run({
        method: props.route.method.toUpperCase(),
        url: buildUrl(),
        headers: (headersValidation.data || { 'Content-Type': 'application/json' }) as Record<
            string,
            string
        >,
        body: bodyValidation.data,
        hasBody: isBodyMethod.value,
    })

    if (testResult.value) {
        await scrollToResponse('response-body', 'response-section')
    }
}

const clearResult = clear
</script>

<template>
    <div
        id="test-form"
        :class="['flex flex-col gap-4', inModal ? 'test-form-modal' : 'test-form-section flex-1']"
    >
        <div class="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <!-- Request Section -->
            <section
                class="space-y-4 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900/70"
            >
                <!-- Route info summary -->
                <div
                    class="flex flex-wrap items-center gap-2 pb-3 border-b border-slate-200 dark:border-slate-700"
                >
                    <span
                        class="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400"
                    >
                        {{ route.method.toUpperCase() }}
                    </span>
                    <code class="text-xs text-slate-700 dark:text-slate-300 truncate min-w-0">{{
                        route.fullUrl
                    }}</code>
                    <span class="ml-auto text-xs text-slate-500 dark:text-slate-400">
                        {{
                            threadCount > 1 || requestCount > 1
                                ? `Batch: ${threadCount}×${requestCount}`
                                : 'Single request'
                        }}
                    </span>
                </div>

                <form class="space-y-4" @submit.prevent="sendRequest">
                    <!-- URL Parameters -->
                    <div v-if="parameters.length > 0">
                        <label
                            class="mb-2 block text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400"
                            >URL Parameters</label
                        >
                        <div class="space-y-2">
                            <div
                                v-for="param in parameters"
                                :key="param.name"
                                class="flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 dark:bg-slate-800/70"
                            >
                                <label
                                    class="min-w-[80px] text-xs font-medium text-slate-600 dark:text-slate-400"
                                    >{{ param.name }}</label
                                >
                                <input
                                    v-model="paramValues[param.name]"
                                    type="text"
                                    :placeholder="`Enter ${param.name}`"
                                    :required="param.required"
                                    class="flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-transparent focus:ring-2 focus:ring-green-500 dark:border-slate-600 dark:bg-slate-800 dark:text-white"
                                />
                            </div>
                        </div>
                    </div>

                    <!-- Headers -->
                    <div>
                        <label
                            class="mb-2 block text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400"
                            >Headers (JSON)</label
                        >
                        <textarea
                            v-model="headers"
                            rows="4"
                            placeholder='{"Content-Type": "application/json"}'
                            class="min-h-[100px] w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-sm text-slate-900 outline-none transition focus:border-transparent focus:ring-2 focus:ring-green-500 dark:border-slate-600 dark:bg-slate-800 dark:text-white"
                            :class="{
                                'json-invalid': headersError,
                                'json-valid': !headersError && headers,
                            }"
                            @input="validateHeaders"
                        ></textarea>
                        <div v-if="headersError" class="json-error-message">
                            JSON Error: {{ headersError }}
                        </div>
                    </div>

                    <!-- Body (POST/PUT/PATCH only) -->
                    <div v-if="isBodyMethod">
                        <label
                            class="mb-2 block text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400"
                            >Request Body (JSON)</label
                        >
                        <textarea
                            v-model="body"
                            rows="8"
                            placeholder='{"key": "value"}'
                            class="min-h-[180px] w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-sm text-slate-900 outline-none transition focus:border-transparent focus:ring-2 focus:ring-green-500 dark:border-slate-600 dark:bg-slate-800 dark:text-white"
                            :class="{ 'json-invalid': bodyError, 'json-valid': !bodyError && body }"
                            @input="validateBody"
                        ></textarea>
                        <div v-if="bodyError" class="json-error-message">
                            JSON Error: {{ bodyError }}
                        </div>
                    </div>

                    <!-- Batch mode toggle + controls -->
                    <div
                        class="rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-800/50"
                    >
                        <label class="flex cursor-pointer items-center gap-2">
                            <input
                                v-model="batchModeEnabled"
                                type="checkbox"
                                class="h-4 w-4 rounded border-slate-300 text-primary-600 focus:ring-primary-500"
                            />
                            <span class="text-xs font-medium text-slate-700 dark:text-slate-300"
                                >Batch / load test mode</span
                            >
                        </label>
                        <div v-if="batchModeEnabled" class="mt-3 grid grid-cols-2 gap-3">
                            <div>
                                <label
                                    class="mb-1.5 block text-xs font-medium text-slate-600 dark:text-slate-400"
                                    >Requests</label
                                >
                                <input
                                    v-model.number="requestCount"
                                    type="number"
                                    min="1"
                                    max="1000"
                                    class="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-center text-sm text-slate-900 outline-none transition focus:border-transparent focus:ring-2 focus:ring-green-500 dark:border-slate-600 dark:bg-slate-800 dark:text-white"
                                />
                            </div>
                            <div>
                                <label
                                    class="mb-1.5 block text-xs font-medium text-slate-600 dark:text-slate-400"
                                    >Threads</label
                                >
                                <input
                                    v-model.number="threadCount"
                                    type="number"
                                    min="1"
                                    max="100"
                                    class="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-center text-sm text-slate-900 outline-none transition focus:border-transparent focus:ring-2 focus:ring-green-500 dark:border-slate-600 dark:bg-slate-800 dark:text-white"
                                />
                            </div>
                        </div>
                    </div>

                    <!-- Actions -->
                    <div class="flex flex-wrap items-center gap-2 justify-between">
                        <button
                            type="button"
                            class="text-xs font-medium text-slate-500 transition hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-100"
                            @click="copyCurl"
                        >
                            {{
                                copyCurlState === 'copied'
                                    ? '✓ cURL copied'
                                    : copyCurlState === 'error'
                                      ? 'Copy failed'
                                      : 'Copy as cURL'
                            }}
                        </button>
                        <div class="flex gap-2">
                            <button
                                type="button"
                                class="inline-flex min-h-[36px] items-center justify-center rounded-lg bg-slate-700 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-slate-500"
                                @click="clearResult"
                            >
                                Clear
                            </button>
                            <button
                                type="submit"
                                :disabled="isLoading"
                                class="inline-flex min-h-[36px] items-center justify-center gap-2 rounded-lg bg-green-700 px-5 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-green-800 focus:outline-none focus:ring-2 focus:ring-green-500 disabled:opacity-50"
                            >
                                <svg
                                    class="h-4 w-4"
                                    fill="none"
                                    stroke="currentColor"
                                    viewBox="0 0 24 24"
                                >
                                    <path
                                        stroke-linecap="round"
                                        stroke-linejoin="round"
                                        stroke-width="2"
                                        d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"
                                    ></path>
                                </svg>
                                {{
                                    isLoading
                                        ? 'Sending...'
                                        : batchModeEnabled && threadCount > 1
                                          ? `Run ${threadCount} threads`
                                          : 'Send Request'
                                }}
                            </button>
                        </div>
                    </div>
                </form>
            </section>

            <!-- Response Section -->
            <section
                id="response-section"
                class="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-700 dark:bg-slate-950/50"
            >
                <div
                    class="flex items-center justify-between gap-3 border-b border-slate-200 pb-3 dark:border-slate-700"
                >
                    <div>
                        <p
                            class="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400"
                        >
                            Response
                        </p>
                        <p class="text-xs text-slate-500 dark:text-slate-400">
                            Status, headers, timing, and payload.
                        </p>
                    </div>
                    <div
                        v-if="progress.isVisible"
                        class="text-xs text-slate-600 dark:text-slate-300"
                    >
                        {{ progress.completedRequests }}/{{ progress.totalRequests }}
                    </div>
                </div>

                <!-- Progress bar -->
                <div
                    v-if="progress.isVisible"
                    class="rounded-lg border border-emerald-400 bg-emerald-50 p-3 dark:border-emerald-900 dark:bg-emerald-950/40"
                >
                    <div class="mb-2 flex items-center justify-between gap-3 text-xs">
                        <span class="font-medium text-emerald-800 dark:text-emerald-200">
                            Thread {{ progress.currentThread }}/{{ progress.totalThreads }}
                        </span>
                        <span class="text-emerald-700 dark:text-emerald-300"
                            >{{ progressPercentage }}%</span
                        >
                    </div>
                    <div
                        class="h-1.5 overflow-hidden rounded-full bg-emerald-100 dark:bg-emerald-900/70"
                    >
                        <div
                            class="h-full rounded-full bg-emerald-500 transition-all duration-300"
                            :style="{ width: `${progressPercentage}%` }"
                        ></div>
                    </div>
                </div>

                <!-- Empty state -->
                <div
                    v-if="!testResult && !progress.isVisible"
                    class="flex min-h-[200px] items-center justify-center rounded-xl border border-dashed border-slate-300 bg-white p-6 text-center dark:border-slate-700 dark:bg-slate-900/40"
                >
                    <div>
                        <p class="text-sm font-medium text-slate-600 dark:text-slate-300">
                            No response yet
                        </p>
                        <p class="mt-1 text-xs text-slate-400 dark:text-slate-500">
                            Run a request to see status, headers and payload.
                        </p>
                    </div>
                </div>

                <template v-else-if="testResult">
                    <!-- Status badge -->
                    <div
                        :class="[
                            'rounded-xl border p-3',
                            testResult.error
                                ? 'border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/30'
                                : testResult.success
                                  ? 'border-emerald-200 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/30'
                                  : 'border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/30',
                        ]"
                    >
                        <div class="flex flex-wrap items-center gap-2">
                            <span class="text-base font-semibold">
                                {{ testResult.status || testResult.firstResult?.status || 0 }}
                                {{
                                    testResult.statusText ||
                                    testResult.firstResult?.statusText ||
                                    ''
                                }}
                            </span>
                            <span
                                class="rounded-full bg-white/80 px-2 py-0.5 text-xs font-medium text-slate-700 dark:bg-slate-900/80 dark:text-slate-200"
                            >
                                {{
                                    testResult.responseTime ||
                                    testResult.firstResult?.responseTime ||
                                    testResult.statistics?.avgResponseTime?.toFixed?.(0) ||
                                    0
                                }}ms
                            </span>
                            <span class="text-xs text-slate-500 dark:text-slate-400"
                                >{{ testResult.method }} {{ testResult.url }}</span
                            >
                        </div>
                        <p
                            v-if="testResult.message"
                            class="mt-2 text-sm text-slate-700 dark:text-slate-200"
                        >
                            {{ testResult.message }}
                        </p>
                        <p
                            v-if="testResult.details"
                            class="mt-1 whitespace-pre-wrap text-xs text-slate-500 dark:text-slate-400"
                        >
                            {{ testResult.details }}
                        </p>
                    </div>

                    <!-- Statistics grid -->
                    <div v-if="testResult.statistics" class="grid gap-2 grid-cols-3">
                        <div
                            class="rounded-lg border border-slate-200 bg-white p-3 dark:bg-slate-900/90 dark:border-slate-700"
                        >
                            <div
                                class="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400"
                            >
                                Total
                            </div>
                            <div class="mt-1 text-base font-semibold">
                                {{ testResult.statistics.totalRequests }}
                            </div>
                        </div>
                        <div
                            class="rounded-lg border border-slate-200 bg-white p-3 dark:bg-slate-900/90 dark:border-slate-700"
                        >
                            <div
                                class="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400"
                            >
                                Success / Failed
                            </div>
                            <div class="mt-1 text-base font-semibold">
                                {{ testResult.statistics.successfulRequests }} /
                                {{ testResult.statistics.failedRequests }}
                            </div>
                        </div>
                        <div
                            class="rounded-lg border border-slate-200 bg-white p-3 dark:bg-slate-900/90 dark:border-slate-700"
                        >
                            <div
                                class="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400"
                            >
                                Avg / Min / Max (ms)
                            </div>
                            <div class="mt-1 text-sm font-semibold">
                                {{ Math.round(testResult.statistics.avgResponseTime) }} /
                                {{ Math.round(testResult.statistics.minResponseTime) }} /
                                {{ Math.round(testResult.statistics.maxResponseTime) }}
                            </div>
                        </div>
                    </div>

                    <!-- Request snapshot (collapsed by default) -->
                    <details
                        class="rounded-xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900/70"
                    >
                        <summary
                            class="cursor-pointer px-4 py-2.5 text-xs font-medium text-slate-600 dark:text-slate-300 select-none"
                        >
                            Request snapshot
                        </summary>
                        <div
                            class="grid gap-3 border-t border-slate-200 px-4 py-3 dark:border-slate-700"
                        >
                            <div>
                                <h6
                                    class="mb-1.5 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400"
                                >
                                    Headers
                                </h6>
                                <pre
                                    class="overflow-x-auto rounded-lg border border-slate-700/80 bg-slate-800 p-3 text-xs text-slate-100"
                                ><code>{{ JSON.stringify(testResult.requestHeaders || {}, null, 2) }}</code></pre>
                            </div>
                            <div
                                v-if="
                                    testResult.requestBody !== undefined &&
                                    testResult.requestBody !== null
                                "
                            >
                                <h6
                                    class="mb-1.5 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400"
                                >
                                    Body
                                </h6>
                                <pre
                                    class="overflow-x-auto rounded-lg border border-slate-700/80 bg-slate-800 p-3 text-xs text-slate-100"
                                ><code>{{ JSON.stringify(testResult.requestBody, null, 2) }}</code></pre>
                            </div>
                        </div>
                    </details>

                    <!-- Response headers -->
                    <div>
                        <h6
                            class="mb-1.5 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400"
                        >
                            Response headers
                        </h6>
                        <pre
                            class="overflow-x-auto rounded-lg border border-slate-700/80 bg-slate-800 p-3 text-xs text-slate-100"
                        ><code>{{ JSON.stringify(testResult.headers || testResult.firstResult?.headers || {}, null, 2) }}</code></pre>
                    </div>

                    <!-- Response body -->
                    <div id="response-body">
                        <h6
                            class="mb-1.5 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400"
                        >
                            Response body
                        </h6>
                        <pre
                            class="max-h-[480px] overflow-auto rounded-xl border border-slate-700/80 bg-slate-800 p-4 text-sm text-slate-100"
                        ><code>{{ responseBodyDisplay }}</code></pre>
                    </div>
                </template>
            </section>
        </div>
    </div>
</template>
