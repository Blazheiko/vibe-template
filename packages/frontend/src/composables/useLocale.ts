import { i18n, loadLocale, SUPPORTED_LOCALES } from '@/plugins/i18n'
import type { SupportedLocale } from '@/plugins/i18n'
import { resolveLanguageCode } from 'shared/enums'

function isSupportedLocale(code: string): code is SupportedLocale {
    return (SUPPORTED_LOCALES as readonly string[]).includes(code)
}

/**
 * The language to ask the Support AI to answer in: the language of the browser among the ones
 * the app recognises (many more than the interface has translations for), not the language of the
 * interface. A Russian browser gets an English interface and a Russian answer.
 */
export function supportLanguage(): string {
    return resolveLanguageCode(navigator.language)
}

/** The interface language of the browser: one that ships, else English. */
export function browserLocale(): SupportedLocale {
    const browserLang = resolveLanguageCode(navigator.language)
    return isSupportedLocale(browserLang) ? browserLang : 'en'
}

/**
 * The language the interface shows (feat-232, Р7): the profile's, else the browser's, else
 * English. `null` is "no choice in the profile".
 */
export function resolveInterfaceLocale(profileLocale: string | null | undefined): SupportedLocale {
    if (typeof profileLocale === 'string' && isSupportedLocale(profileLocale)) return profileLocale
    return browserLocale()
}

let latestRequest = 0

/**
 * Switches the interface to the profile language (or back to the browser's for `null`) without
 * a reload. A language whose file does not load shows English (`loadLocale`). Of two quick
 * switches the later one wins, whichever file arrives first.
 */
export async function applyLocalePreference(
    profileLocale: string | null | undefined,
): Promise<SupportedLocale> {
    latestRequest += 1
    const request = latestRequest
    const loaded = await loadLocale(resolveInterfaceLocale(profileLocale))
    if (request === latestRequest) {
        i18n.global.locale.value = loaded
        document.documentElement.setAttribute('lang', loaded)
    }
    return loaded
}

// Standalone initializer for use outside of components (e.g. before app mount)
export async function initLocaleStandalone(): Promise<void> {
    i18n.global.locale.value = await loadLocale(browserLocale())
}
