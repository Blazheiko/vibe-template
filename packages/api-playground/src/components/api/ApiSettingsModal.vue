<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useApiSettingsStore } from '@/stores/api-settings'
import { checkServerHealth } from '@/utils/base-api'

interface Props {
    isOpen: boolean
}

type Emits = (e: 'close') => void

const props = defineProps<Props>()
const emit = defineEmits<Emits>()

const apiSettingsStore = useApiSettingsStore()

const localUseBaseUrlOverride = ref(false)
const localBaseUrl = ref(apiSettingsStore.baseUrlOverride || apiSettingsStore.envBaseUrl)
const localHeaders = ref<{ key: string; value: string }[]>([])
const serverStatus = ref<'checking' | 'online' | 'offline' | null>(null)

const convertHeadersToArray = () => {
    localHeaders.value = Object.entries(apiSettingsStore.globalHeaders).map(([key, value]) => ({
        key,
        value,
    }))

    if (
        localHeaders.value.length === 0 ||
        localHeaders.value[localHeaders.value.length - 1]?.key !== ''
    ) {
        localHeaders.value.push({ key: '', value: '' })
    }
}

const syncLocalState = () => {
    localUseBaseUrlOverride.value = apiSettingsStore.hasBaseUrlOverride
    localBaseUrl.value = apiSettingsStore.baseUrlOverride || apiSettingsStore.envBaseUrl
    convertHeadersToArray()
    serverStatus.value = null
}

watch(() => apiSettingsStore.globalHeaders, convertHeadersToArray, { immediate: true })
watch(
    () => props.isOpen,
    (isOpen) => {
        if (isOpen) {
            syncLocalState()
        }
    },
)

const effectiveBaseUrl = computed(() => {
    return localUseBaseUrlOverride.value ? localBaseUrl.value.trim() : apiSettingsStore.envBaseUrl
})

const isValidUrl = computed(() => {
    if (!localUseBaseUrlOverride.value) {
        return true
    }

    try {
        new URL(localBaseUrl.value)
        return true
    } catch {
        return localBaseUrl.value.startsWith('http://') || localBaseUrl.value.startsWith('https://')
    }
})

const addHeaderRow = () => {
    localHeaders.value.push({ key: '', value: '' })
}

const removeHeaderRow = (index: number) => {
    localHeaders.value.splice(index, 1)
    if (localHeaders.value.length === 0) {
        addHeaderRow()
    }
}

const handleHeaderKeyChange = (index: number, newKey: string) => {
    if (localHeaders.value[index]) {
        localHeaders.value[index].key = newKey
    }

    const lastIndex = localHeaders.value.length - 1
    if (index === lastIndex && newKey !== '' && localHeaders.value[lastIndex]?.value !== '') {
        addHeaderRow()
    }
}

const handleHeaderValueChange = (index: number, newValue: string) => {
    if (localHeaders.value[index]) {
        localHeaders.value[index].value = newValue
    }

    const lastIndex = localHeaders.value.length - 1
    if (index === lastIndex && newValue !== '' && localHeaders.value[lastIndex]?.key !== '') {
        addHeaderRow()
    }
}

const saveSettings = () => {
    if (localUseBaseUrlOverride.value) {
        apiSettingsStore.setBaseUrlOverride(localBaseUrl.value)
    } else {
        apiSettingsStore.clearBaseUrlOverride()
    }

    const headersObject: Record<string, string> = {}
    localHeaders.value.forEach(({ key, value }) => {
        if (key.trim() && value.trim()) {
            headersObject[key.trim()] = value.trim()
        }
    })

    apiSettingsStore.setGlobalHeaders(headersObject)
    emit('close')
}

const resetToDefaults = () => {
    apiSettingsStore.resetToDefaults()
    syncLocalState()
}

const closeModal = () => {
    emit('close')
}

const checkServer = async () => {
    // An empty base URL is the dev server's own origin: the check goes through its proxy.
    serverStatus.value = 'checking'
    try {
        const isOnline = await checkServerHealth(effectiveBaseUrl.value)
        serverStatus.value = isOnline ? 'online' : 'offline'
    } catch {
        serverStatus.value = 'offline'
    }
}

const getServerStatusColor = () => {
    switch (serverStatus.value) {
        case 'checking':
            return 'text-yellow-600 dark:text-yellow-400'
        case 'online':
            return 'text-green-600 dark:text-green-400'
        case 'offline':
            return 'text-red-600 dark:text-red-400'
        default:
            return 'text-gray-600 dark:text-gray-400'
    }
}

const getServerStatusText = () => {
    switch (serverStatus.value) {
        case 'checking':
            return 'Checking...'
        case 'online':
            return 'Server is online'
        case 'offline':
            return 'Server is offline'
        default:
            return 'Click to check'
    }
}
</script>

<template>
    <div
        v-if="isOpen"
        class="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4"
        @click="closeModal"
    >
        <div
            class="max-h-[90vh] w-full max-w-2xl overflow-hidden rounded-xl bg-white shadow-xl dark:bg-slate-900 border border-slate-200 dark:border-slate-700"
            @click.stop
        >
            <div
                class="flex items-center justify-between border-b border-slate-200 px-5 py-4 dark:border-slate-700"
            >
                <h2 class="text-base font-semibold text-slate-900 dark:text-slate-100">
                    API Settings
                </h2>
                <button
                    @click="closeModal"
                    class="text-slate-400 transition-colors hover:text-slate-600 dark:hover:text-slate-300"
                    aria-label="Close settings"
                >
                    <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            stroke-width="2"
                            d="M6 18L18 6M6 6l12 12"
                        ></path>
                    </svg>
                </button>
            </div>

            <div class="max-h-[calc(90vh-140px)] overflow-y-auto p-5">
                <div
                    class="mb-5 rounded-xl border border-blue-200 bg-blue-50 p-4 dark:border-blue-800 dark:bg-blue-950/30"
                >
                    <div class="flex items-center justify-between gap-3">
                        <div>
                            <div class="text-sm font-medium text-blue-900 dark:text-blue-100">
                                Environment Base URL
                            </div>
                            <div
                                class="mt-1 break-all font-mono text-sm text-blue-800 dark:text-blue-200"
                            >
                                {{ apiSettingsStore.envBaseUrl }}
                            </div>
                        </div>
                        <span
                            class="rounded-full bg-blue-100 px-2.5 py-1 text-xs font-semibold uppercase tracking-wider text-blue-700 dark:bg-blue-900/60 dark:text-blue-200"
                        >
                            env
                        </span>
                    </div>
                    <p class="mt-2 text-xs text-blue-700 dark:text-blue-300">
                        By default requests always use
                        <code class="font-mono">VITE_API_BASE_URL</code>.
                    </p>
                </div>

                <div
                    class="mb-5 rounded-xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950/30"
                >
                    <div class="mb-3 flex items-start justify-between gap-3">
                        <div>
                            <label class="text-sm font-medium text-slate-700 dark:text-slate-300">
                                Session Base URL Override
                            </label>
                            <p class="mt-1 text-xs text-slate-600 dark:text-slate-400">
                                Optional override for the current session only. Not saved to
                                localStorage.
                            </p>
                        </div>
                        <span
                            :class="[
                                'rounded-full px-2.5 py-1 text-xs font-semibold uppercase tracking-wider flex-shrink-0',
                                localUseBaseUrlOverride
                                    ? 'bg-amber-200 text-amber-900 dark:bg-amber-900/60 dark:text-amber-100'
                                    : 'bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200',
                            ]"
                        >
                            {{ localUseBaseUrlOverride ? 'override active' : 'env only' }}
                        </span>
                    </div>

                    <label class="mb-3 flex cursor-pointer items-center gap-2">
                        <input
                            v-model="localUseBaseUrlOverride"
                            type="checkbox"
                            class="h-4 w-4 rounded border-slate-300 text-primary-600 focus:ring-primary-500"
                        />
                        <span class="text-sm text-slate-700 dark:text-slate-300"
                            >Use session override</span
                        >
                    </label>

                    <input
                        v-model="localBaseUrl"
                        type="text"
                        placeholder="http://127.0.0.1:3000"
                        :disabled="!localUseBaseUrlOverride"
                        class="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-transparent focus:ring-2 focus:ring-primary-500 disabled:cursor-not-allowed disabled:bg-slate-100 dark:border-slate-600 dark:bg-slate-800 dark:text-white dark:disabled:bg-slate-700"
                        :class="{ 'border-red-500 dark:border-red-500': !isValidUrl }"
                    />
                    <p
                        v-if="localUseBaseUrlOverride && !isValidUrl"
                        class="mt-1 text-xs text-red-600 dark:text-red-400"
                    >
                        Please enter a valid URL
                    </p>

                    <div class="mt-3 flex items-center justify-between gap-3">
                        <div class="text-xs text-slate-600 dark:text-slate-400">
                            Effective:
                            <span class="font-mono text-slate-900 dark:text-slate-100">{{
                                effectiveBaseUrl
                            }}</span>
                        </div>
                        <button
                            @click="checkServer"
                            :disabled="!isValidUrl || serverStatus === 'checking'"
                            class="flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-600 dark:hover:bg-slate-800"
                        >
                            <svg
                                v-if="serverStatus === 'checking'"
                                class="h-3.5 w-3.5 animate-spin text-yellow-600 dark:text-yellow-400"
                                fill="none"
                                viewBox="0 0 24 24"
                            >
                                <circle
                                    class="opacity-25"
                                    cx="12"
                                    cy="12"
                                    r="10"
                                    stroke="currentColor"
                                    stroke-width="4"
                                ></circle>
                                <path
                                    class="opacity-75"
                                    fill="currentColor"
                                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                                ></path>
                            </svg>
                            <svg
                                v-else
                                class="h-3.5 w-3.5 text-slate-600 dark:text-slate-400"
                                fill="none"
                                stroke="currentColor"
                                viewBox="0 0 24 24"
                            >
                                <path
                                    stroke-linecap="round"
                                    stroke-linejoin="round"
                                    stroke-width="2"
                                    d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                                ></path>
                            </svg>
                            Test Connection
                        </button>
                    </div>
                    <div :class="getServerStatusColor()" class="mt-1.5 text-xs font-medium">
                        {{ getServerStatusText() }}
                    </div>
                </div>

                <div class="mb-5">
                    <div class="mb-3 flex items-center justify-between">
                        <label class="block text-sm font-medium text-slate-700 dark:text-slate-300">
                            Global Headers
                        </label>
                        <div class="flex items-center gap-3">
                            <label class="flex cursor-pointer items-center gap-2">
                                <input
                                    type="checkbox"
                                    :checked="apiSettingsStore.enableGlobalHeaders"
                                    @change="
                                        apiSettingsStore.setEnableGlobalHeaders(
                                            ($event.target as HTMLInputElement).checked,
                                        )
                                    "
                                    class="sr-only"
                                />
                                <div class="relative">
                                    <div
                                        class="block h-5 w-9 rounded-full bg-slate-300 transition-colors dark:bg-slate-600"
                                        :class="{
                                            'bg-primary-600': apiSettingsStore.enableGlobalHeaders,
                                        }"
                                    ></div>
                                    <div
                                        class="dot absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white transition-transform"
                                        :class="{
                                            'transform translate-x-4':
                                                apiSettingsStore.enableGlobalHeaders,
                                        }"
                                    ></div>
                                </div>
                                <span class="text-xs text-slate-600 dark:text-slate-400">
                                    {{
                                        apiSettingsStore.enableGlobalHeaders
                                            ? 'Enabled'
                                            : 'Disabled'
                                    }}
                                </span>
                            </label>
                            <button
                                @click="addHeaderRow"
                                :disabled="!apiSettingsStore.enableGlobalHeaders"
                                class="text-xs font-medium text-primary-600 hover:text-primary-700 disabled:cursor-not-allowed disabled:text-slate-400 dark:text-primary-400 dark:hover:text-primary-300"
                            >
                                + Add
                            </button>
                        </div>
                    </div>

                    <div
                        class="space-y-2"
                        :class="{ 'opacity-50': !apiSettingsStore.enableGlobalHeaders }"
                    >
                        <div
                            v-for="(header, index) in localHeaders"
                            :key="index"
                            class="flex items-center gap-2"
                        >
                            <input
                                :value="header.key"
                                @input="
                                    handleHeaderKeyChange(
                                        index,
                                        ($event.target as HTMLInputElement).value,
                                    )
                                "
                                type="text"
                                placeholder="Header name"
                                :disabled="!apiSettingsStore.enableGlobalHeaders"
                                class="flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-transparent focus:ring-2 focus:ring-primary-500 disabled:cursor-not-allowed disabled:bg-slate-100 dark:border-slate-600 dark:bg-slate-800 dark:text-white dark:disabled:bg-slate-700"
                            />
                            <input
                                :value="header.value"
                                @input="
                                    handleHeaderValueChange(
                                        index,
                                        ($event.target as HTMLInputElement).value,
                                    )
                                "
                                type="text"
                                placeholder="Value"
                                :disabled="!apiSettingsStore.enableGlobalHeaders"
                                class="flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-transparent focus:ring-2 focus:ring-primary-500 disabled:cursor-not-allowed disabled:bg-slate-100 dark:border-slate-600 dark:bg-slate-800 dark:text-white dark:disabled:bg-slate-700"
                            />
                            <button
                                v-if="localHeaders.length > 1"
                                @click="removeHeaderRow(index)"
                                class="p-1.5 text-red-500 transition-colors hover:text-red-600 dark:text-red-400 dark:hover:text-red-300"
                                title="Remove"
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
                                        d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                                    ></path>
                                </svg>
                            </button>
                        </div>
                    </div>
                </div>

                <div class="rounded-xl bg-slate-50 p-4 dark:bg-slate-800">
                    <h3
                        class="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400"
                    >
                        Current Settings
                    </h3>
                    <div class="space-y-1 text-xs text-slate-600 dark:text-slate-400">
                        <div>
                            <span class="font-medium text-slate-700 dark:text-slate-300"
                                >Base URL:</span
                            >
                            <span class="font-mono">{{ apiSettingsStore.baseUrl }}</span>
                        </div>
                        <div>
                            <span class="font-medium text-slate-700 dark:text-slate-300"
                                >Session Override:</span
                            >
                            <span
                                :class="
                                    apiSettingsStore.hasBaseUrlOverride
                                        ? 'text-amber-600 dark:text-amber-400'
                                        : 'text-slate-500 dark:text-slate-400'
                                "
                            >
                                {{
                                    apiSettingsStore.hasBaseUrlOverride
                                        ? apiSettingsStore.baseUrlOverride
                                        : 'Not set'
                                }}
                            </span>
                        </div>
                        <div>
                            <span class="font-medium text-slate-700 dark:text-slate-300"
                                >Global Headers:</span
                            >
                            <span
                                :class="
                                    apiSettingsStore.enableGlobalHeaders
                                        ? 'text-green-600 dark:text-green-400'
                                        : 'text-red-600 dark:text-red-400'
                                "
                            >
                                {{ apiSettingsStore.enableGlobalHeaders ? 'Enabled' : 'Disabled' }}
                            </span>
                        </div>
                    </div>
                </div>
            </div>

            <div
                class="flex items-center justify-between border-t border-slate-200 px-5 py-4 dark:border-slate-700"
            >
                <button
                    @click="resetToDefaults"
                    class="rounded-lg bg-slate-100 px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-200 dark:bg-slate-700 dark:text-slate-300 dark:hover:bg-slate-600"
                >
                    Reset
                </button>

                <div class="flex gap-2">
                    <button
                        @click="closeModal"
                        class="rounded-lg bg-slate-100 px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-200 dark:bg-slate-700 dark:text-slate-300 dark:hover:bg-slate-600"
                    >
                        Cancel
                    </button>
                    <button
                        @click="saveSettings"
                        :disabled="!isValidUrl"
                        class="rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-700 disabled:cursor-not-allowed disabled:bg-slate-400"
                    >
                        Save
                    </button>
                </div>
            </div>
        </div>
    </div>
</template>
