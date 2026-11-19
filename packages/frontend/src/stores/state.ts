import { computed, reactive, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import {
    DEFAULT_COLOR_THEME,
    DEFAULT_FONT_SIZE,
    FONT_SIZE_MAX,
    FONT_SIZE_MIN,
    isColorTheme,
    isShippedLocale,
    isTheme,
    type ColorTheme,
    type ShippedLocaleCode,
    type Theme,
} from 'shared/enums'
import { isAllowedTimeZone } from 'shared/utils'
import { isPwaMode } from '@/utils/app-type'
import type { StorageConfig } from '@/utils/storage-url'

export type { StorageConfig }

/**
 * The interface preferences as shown (feat-232): an explicit choice or `null`, which shows the
 * default (Р2): the system theme, DEFAULT_COLOR_THEME, DEFAULT_FONT_SIZE, the browser language
 * and time zone.
 */
export interface DisplayedPreferences {
    locale: ShippedLocaleCode | null
    timeZone: string | null
    theme: Theme | null
    colorTheme: ColorTheme | null
    fontSize: number | null
}

export type DevicePreference = 'theme' | 'colorTheme' | 'fontSize'

/** Browser-wide keys: the look of the anonymous pages (login, registration). */
const DEVICE_KEYS: Record<DevicePreference, string> = {
    theme: 'theme',
    colorTheme: 'colorTheme',
    fontSize: 'fontSize',
}
/** The account whose cached preferences the next start shows in its first frame (Р10). */
export const ACCOUNT_POINTER_KEY = 'prefs:current'
export const accountCacheKey = (userId: string): string => `prefs:${userId}`

const readStorage = (key: string): string | null => {
    try {
        return localStorage.getItem(key)
    } catch {
        return null
    }
}
const writeStorage = (key: string, value: string | null): void => {
    try {
        if (value === null) localStorage.removeItem(key)
        else localStorage.setItem(key, value)
    } catch {
        // Storage blocked or full: the preferences still apply for this page.
    }
}

const fontSizeOrNull = (value: unknown): number | null =>
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= FONT_SIZE_MIN &&
    value <= FONT_SIZE_MAX
        ? value
        : null

/** Anything that does not parse as a preference is `null`: a cache never breaks the page. */
export function sanitizePreferences(value: unknown): DisplayedPreferences {
    const record =
        typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
    const locale = record.locale
    const timeZone = record.timeZone
    return {
        locale: typeof locale === 'string' && isShippedLocale(locale) ? locale : null,
        timeZone: isAllowedTimeZone(timeZone) ? timeZone : null,
        theme: isTheme(record.theme) ? record.theme : null,
        colorTheme: isColorTheme(record.colorTheme) ? record.colorTheme : null,
        fontSize: fontSizeOrNull(record.fontSize),
    }
}

export function readDevicePreferences(): DisplayedPreferences {
    const theme = readStorage(DEVICE_KEYS.theme)
    const colorTheme = readStorage(DEVICE_KEYS.colorTheme)
    const fontSize = readStorage(DEVICE_KEYS.fontSize)
    return {
        locale: null,
        timeZone: null,
        theme: isTheme(theme) ? theme : null,
        colorTheme: isColorTheme(colorTheme) ? colorTheme : null,
        fontSize: fontSize === null ? null : fontSizeOrNull(Number(fontSize)),
    }
}

export function readAccountCache(userId: string): DisplayedPreferences | null {
    const raw = readStorage(accountCacheKey(userId))
    if (raw === null) return null
    try {
        return sanitizePreferences(JSON.parse(raw))
    } catch {
        return null
    }
}

const prefersDarkQuery = (): MediaQueryList | null =>
    typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-color-scheme: dark)')
        : null

export const useStateStore = defineStore('state', () => {
    // The first frame: the cached preferences of the account signed in last (no theme flash after
    // the first sign-in on this device), else the device's own. GET /main/init replaces them.
    const pointer = readStorage(ACCOUNT_POINTER_KEY)
    const cached = pointer === null ? null : readAccountCache(pointer)
    /** The account whose preferences are shown; `null` while the device's own are. */
    const owner = ref<string | null>(cached === null ? null : pointer)
    const shown = reactive<DisplayedPreferences>(cached ?? readDevicePreferences())
    const systemDark = ref(prefersDarkQuery()?.matches === true)

    // Р13: the system theme decides only while no theme is chosen.
    const darkMode = computed(() =>
        shown.theme === null ? systemDark.value : shown.theme === 'dark',
    )
    const theme = computed(() => shown.theme)
    const colorTheme = computed<ColorTheme>(() => shown.colorTheme ?? DEFAULT_COLOR_THEME)
    const fontSize = computed(() => shown.fontSize ?? DEFAULT_FONT_SIZE)
    const locale = computed(() => shown.locale)
    const timeZone = computed(() => shown.timeZone)

    const windowWidth = ref(window.innerWidth)
    const isMobile = ref(window.innerWidth <= 768)
    const isPWAMode = ref(false)

    const storageConfig = ref<StorageConfig>({
        cdnUrl: '',
        s3Prefix: '',
        s3StaticDataPrefix: '',
        s3DynamicDataPrefix: '',
    })

    const handleResize = () => {
        windowWidth.value = window.innerWidth
        isMobile.value = window.innerWidth <= 768
    }

    const setStorageConfig = (config: Partial<StorageConfig>) => {
        storageConfig.value = {
            ...storageConfig.value,
            ...config,
        }
    }

    const checkPWAMode = () => {
        isPWAMode.value = isPwaMode()
        return isPWAMode.value
    }

    checkPWAMode()

    const standaloneMediaQuery = window.matchMedia('(display-mode: standalone)')
    const minimalUIMediaQuery = window.matchMedia('(display-mode: minimal-ui)')

    standaloneMediaQuery.addEventListener('change', checkPWAMode)
    minimalUIMediaQuery.addEventListener('change', checkPWAMode)

    window.addEventListener('resize', handleResize)

    function applyTheme() {
        document.documentElement.classList.toggle('dark-theme', darkMode.value)
        document.documentElement.setAttribute('data-theme', colorTheme.value)
    }

    function applyFontSize() {
        const size = fontSize.value
        document.documentElement.style.setProperty('--app-font-size', `${String(size)}px`)
        document.documentElement.style.fontSize = `${String(size)}px`
        document.documentElement.style.setProperty('--app-font-scale', String(size / 16))

        // document.body is null while the <head> is still being parsed.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (document.body) {
            // Never scale the whole page; font size setting should only affect typography.
            document.body.style.zoom = ''
        }
    }

    applyTheme()
    applyFontSize()
    watch([darkMode, colorTheme], applyTheme)
    watch(fontSize, applyFontSize)

    function show(preferences: DisplayedPreferences) {
        Object.assign(shown, preferences)
    }

    /** Signed out: the device's own preferences, and no account shows at the next start. */
    function showDevicePreferences() {
        owner.value = null
        writeStorage(ACCOUNT_POINTER_KEY, null)
        show(readDevicePreferences())
    }

    /**
     * Another account is signed in (Р10): first the device's preferences, then that account's
     * cache, if this device has one. What the account showed before never carries over.
     */
    function showAccountFromCache(userId: string) {
        if (owner.value === userId) return
        show(readDevicePreferences())
        const cache = readAccountCache(userId)
        if (cache !== null) show(cache)
        owner.value = userId
        writeStorage(ACCOUNT_POINTER_KEY, userId)
    }

    /**
     * The preferences of `userId` as the account has them now (the confirmed profile with the
     * unsaved changes on top). A `null` from the server replaces whatever the cache held (Р2).
     */
    function showAccountPreferences(userId: string, preferences: DisplayedPreferences) {
        if (owner.value !== userId) showAccountFromCache(userId)
        const clean = sanitizePreferences(preferences)
        show(clean)
        writeStorage(accountCacheKey(userId), JSON.stringify(clean))
    }

    /** A choice on the device itself: only while no account is signed in. */
    function setDevicePreference<K extends DevicePreference>(
        key: K,
        value: DisplayedPreferences[K],
    ) {
        if (owner.value !== null) return
        shown[key] = value
        writeStorage(DEVICE_KEYS[key], value === null ? null : String(value))
    }

    function setSystemDark(value: boolean) {
        systemDark.value = value
    }

    return {
        owner,
        theme,
        darkMode,
        colorTheme,
        fontSize,
        locale,
        timeZone,
        systemDark,
        showDevicePreferences,
        showAccountFromCache,
        showAccountPreferences,
        setDevicePreference,
        setSystemDark,
        windowWidth,
        isMobile,
        isPWAMode,
        checkPWAMode,
        storageConfig,
        setStorageConfig,
    }
})
