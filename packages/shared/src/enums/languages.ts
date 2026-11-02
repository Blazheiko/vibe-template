export const APP_LOCALE_CODES = [
    'en',
    'ru',
    'uk',
    'de',
    'fr',
    'es',
    'it',
    'pt',
    'pl',
    'nl',
    'sv',
    'cs',
    'zh',
    'ja',
    'ko',
    'ar',
    'tr',
    'hi',
] as const

/**
 * The languages the interface has translations for (`packages/frontend/src/locales`). The
 * Support AI and the language recognition above know more languages than the interface does;
 * any other language shows the interface in English.
 */
export const SHIPPED_LOCALE_CODES = ['en', 'uk', 'pl'] as const
export type ShippedLocaleCode = (typeof SHIPPED_LOCALE_CODES)[number]

export function isShippedLocale(code: string): code is ShippedLocaleCode {
    return (SHIPPED_LOCALE_CODES as readonly string[]).includes(code)
}

const APP_LOCALE_CODE_SET = new Set<string>(APP_LOCALE_CODES)

export const LANGUAGE_NAME_BY_CODE: Record<string, string> = {
    uk: 'Ukrainian',
    ga: 'Irish',
    en: 'English',
    pl: 'Polish',
    de: 'German',
    fr: 'French',
    es: 'Spanish',
    it: 'Italian',
    pt: 'Portuguese',
    tr: 'Turkish',
    ja: 'Japanese',
    ko: 'Korean',
    zh: 'Chinese',
    ar: 'Arabic',
    hi: 'Hindi',
    cs: 'Czech',
    nl: 'Dutch',
    sv: 'Swedish',
    no: 'Norwegian',
    da: 'Danish',
    fi: 'Finnish',
    el: 'Greek',
    he: 'Hebrew',
    th: 'Thai',
    vi: 'Vietnamese',
    ro: 'Romanian',
    hu: 'Hungarian',
    bg: 'Bulgarian',
    hr: 'Croatian',
    sk: 'Slovak',
    sl: 'Slovenian',
    sr: 'Serbian',
    ka: 'Georgian',
    ru: 'Russian',
}

export const LANGUAGE_NATIVE_NAME_BY_CODE: Record<string, string> = {
    uk: 'Українська',
    ga: 'Gaeilge',
    en: 'English',
    pl: 'Polski',
    de: 'Deutsch',
    fr: 'Français',
    es: 'Español',
    it: 'Italiano',
    pt: 'Português',
    tr: 'Türkçe',
    ja: '日本語',
    ko: '한국어',
    zh: '中文',
    ar: 'العربية',
    hi: 'हिन्दी',
    cs: 'Čeština',
    nl: 'Nederlands',
    sv: 'Svenska',
    no: 'Norsk',
    da: 'Dansk',
    fi: 'Suomi',
    el: 'Ελληνικά',
    he: 'עברית',
    th: 'ไทย',
    vi: 'Tiếng Việt',
    ro: 'Română',
    hu: 'Magyar',
    bg: 'Български',
    hr: 'Hrvatski',
    sk: 'Slovenčina',
    sl: 'Slovenščina',
    sr: 'Српски',
    ka: 'ქართული',
    ru: 'Русский',
}

/**
 * Resolves a language code (e.g. "ru", "en-US") to its English name.
 * Falls back to the raw code if not found.
 */
export function resolveLanguageName(code: string): string {
    const normalized = code.trim().toLowerCase().split(/[-_]/)[0] ?? code.trim().toLowerCase()
    return LANGUAGE_NAME_BY_CODE[normalized] ?? code
}

export function resolveLanguageNativeName(code: string): string {
    const normalized = code.trim().toLowerCase().split(/[-_]/)[0] ?? code.trim().toLowerCase()
    return LANGUAGE_NATIVE_NAME_BY_CODE[normalized] ?? resolveLanguageName(code)
}

export function formatLanguageLabel(code: string): string {
    const englishName = resolveLanguageName(code)
    const nativeName = resolveLanguageNativeName(code)
    return `${englishName} (${nativeName})`
}

/**
 * Resolves the best matching language code from a browser locale string.
 * e.g. "uk-UA" → "uk", "zh-CN" → "zh", "en-US" → "en"
 * Falls back to "en" if the locale is not in the supported list.
 * For Accept-Language lists we intentionally take the first item only and
 * ignore q-priorities to keep the mapping deterministic and simple.
 */
export function resolveLanguageCode(locale: string): string {
    const firstLocale =
        locale.split(',')[0]?.trim().split(';')[0]?.trim().replace(/_/g, '-') ?? 'en'
    const base = firstLocale.split('-')[0]?.toLowerCase() ?? 'en'
    return APP_LOCALE_CODE_SET.has(base) ? base : 'en'
}

export function isAppLocaleCode(code: string): boolean {
    return APP_LOCALE_CODE_SET.has(code.trim().toLowerCase())
}
