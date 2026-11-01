import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

const LEGACY_BASE_URL = ''
const FALLBACK_BASE_URL = ''
const BASE_URL = import.meta.env.VITE_API_BASE_URL?.trim() || FALLBACK_BASE_URL

export interface ApiSettings {
    baseUrl: string
    pathPrefix: string
    globalHeaders: Record<string, string>
    enableGlobalHeaders: boolean
}

export const useApiSettingsStore = defineStore('api-settings', () => {
    const envBaseUrl = BASE_URL
    const persistedBaseUrl = ref<string>(BASE_URL)
    const baseUrlOverride = ref<string>('')
    const pathPrefix = ref<string>('')
    const globalHeaders = ref<Record<string, string>>({})
    const enableGlobalHeaders = ref<boolean>(true)

    const hasBaseUrlOverride = computed(() => Boolean(baseUrlOverride.value.trim()))
    const baseUrl = computed<string>(() => {
        const overrideUrl = baseUrlOverride.value.trim()
        return overrideUrl || persistedBaseUrl.value
    })

    const settings = computed<ApiSettings>(() => ({
        baseUrl: baseUrl.value,
        globalHeaders: enableGlobalHeaders.value ? globalHeaders.value : {},
        enableGlobalHeaders: enableGlobalHeaders.value,
        pathPrefix: pathPrefix.value,
    }))

    // Actions
    const setBaseUrl = (url: string) => {
        const normalizedUrl = url.trim()
        persistedBaseUrl.value =
            !normalizedUrl || normalizedUrl === LEGACY_BASE_URL ? BASE_URL : normalizedUrl
        saveToLocalStorage()
    }

    const setBaseUrlOverride = (url: string) => {
        baseUrlOverride.value = url.trim()
    }

    const clearBaseUrlOverride = () => {
        baseUrlOverride.value = ''
    }

    const setPathPrefix = (prefix: string) => {
        pathPrefix.value = prefix
        saveToLocalStorage()
    }

    const setGlobalHeaders = (headers: Record<string, string>) => {
        globalHeaders.value = headers
        saveToLocalStorage()
    }

    const addGlobalHeader = (key: string, value: string) => {
        globalHeaders.value[key] = value
        saveToLocalStorage()
    }

    const removeGlobalHeader = (key: string) => {
        Reflect.deleteProperty(globalHeaders.value, key)
        saveToLocalStorage()
    }

    const setEnableGlobalHeaders = (enabled: boolean) => {
        enableGlobalHeaders.value = enabled
        saveToLocalStorage()
    }

    const resetToDefaults = () => {
        persistedBaseUrl.value = BASE_URL
        baseUrlOverride.value = ''
        pathPrefix.value = ''
        globalHeaders.value = {}
        enableGlobalHeaders.value = true
        saveToLocalStorage()
    }

    // Where the settings live. The base URL, path prefix and the on/off switch are harmless and
    // are remembered across tabs (localStorage). The header VALUES are credentials a developer
    // types to try the API (Authorization, Cookie, API keys): they go to sessionStorage, which
    // lasts one tab, and never to localStorage, where they would outlive it and be readable by
    // every script of the origin.
    const SETTINGS_KEY = 'api-settings'

    const saveToLocalStorage = () => {
        try {
            localStorage.setItem(
                SETTINGS_KEY,
                JSON.stringify({
                    baseUrl: persistedBaseUrl.value,
                    pathPrefix: pathPrefix.value,
                    enableGlobalHeaders: enableGlobalHeaders.value,
                }),
            )
            sessionStorage.setItem(
                SETTINGS_KEY,
                JSON.stringify({ globalHeaders: globalHeaders.value }),
            )
        } catch (error) {
            console.error('Error saving API settings:', error)
        }
    }

    const loadFromLocalStorage = () => {
        try {
            const saved = localStorage.getItem(SETTINGS_KEY)
            if (saved) {
                // localStorage may hold settings from an older version.
                const settingsData = JSON.parse(saved) as Partial<ApiSettings>
                const savedBaseUrl = settingsData.baseUrl?.trim()
                persistedBaseUrl.value =
                    !savedBaseUrl || savedBaseUrl === LEGACY_BASE_URL ? BASE_URL : savedBaseUrl
                pathPrefix.value = settingsData.pathPrefix || ''
                enableGlobalHeaders.value = settingsData.enableGlobalHeaders ?? true
                // An older version stored the header values here too: forget them and rewrite
                // the entry without them.
                if ('globalHeaders' in settingsData) {
                    localStorage.setItem(
                        SETTINGS_KEY,
                        JSON.stringify({
                            baseUrl: persistedBaseUrl.value,
                            pathPrefix: pathPrefix.value,
                            enableGlobalHeaders: enableGlobalHeaders.value,
                        }),
                    )
                }
            }
            const session = sessionStorage.getItem(SETTINGS_KEY)
            if (session) {
                const sessionData = JSON.parse(session) as {
                    globalHeaders?: Record<string, string>
                }
                globalHeaders.value = sessionData.globalHeaders ?? {}
            }
        } catch (error) {
            console.error('Error loading API settings:', error)
            resetToDefaults()
        }
    }

    // Initialize settings on store creation
    loadFromLocalStorage()

    return {
        // State
        envBaseUrl,
        baseUrl,
        baseUrlOverride,
        hasBaseUrlOverride,
        pathPrefix,
        globalHeaders,
        enableGlobalHeaders,
        settings,

        // Actions
        setBaseUrl,
        setBaseUrlOverride,
        clearBaseUrlOverride,
        setPathPrefix,
        setGlobalHeaders,
        addGlobalHeader,
        removeGlobalHeader,
        setEnableGlobalHeaders,
        resetToDefaults,
        loadFromLocalStorage,
    }
})
