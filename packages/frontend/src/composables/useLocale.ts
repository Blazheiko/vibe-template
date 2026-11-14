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

// Standalone initializer for use outside of components (e.g. before app mount)
export async function initLocaleStandalone(): Promise<void> {
    const browserLang = resolveLanguageCode(navigator.language)
    const lang = isSupportedLocale(browserLang) ? browserLang : 'en'
    i18n.global.locale.value = await loadLocale(lang)
}
