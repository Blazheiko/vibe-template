import { useI18n } from 'vue-i18n'
import { i18n, loadLocale, SUPPORTED_LOCALES } from '@/plugins/i18n'
import type { SupportedLocale } from '@/plugins/i18n'
import { resolveLanguageCode } from 'shared/enums'

function isSupportedLocale(code: string): code is SupportedLocale {
    return (SUPPORTED_LOCALES as readonly string[]).includes(code)
}

export function useLocale() {
    const { locale } = useI18n({ useScope: 'global' })

    async function applyLocale(code: string): Promise<void> {
        const lang = isSupportedLocale(code) ? code : 'en'
        locale.value = await loadLocale(lang)
    }

    async function applyLocaleFromNativeLanguage(langNative?: string | null): Promise<void> {
        if (langNative === null || langNative === undefined || langNative === '') {
            if (locale.value !== 'en') {
                await applyLocale('en')
            }
            return
        }

        const resolved = resolveLanguageCode(langNative)
        if (locale.value !== resolved) {
            await applyLocale(resolved)
        }
    }

    async function initFromUser(langNative?: string | null): Promise<void> {
        await applyLocaleFromNativeLanguage(langNative)

        // initLocaleStandalone() already applied the browser-locale fallback
        // before the app mounted.
    }

    return { locale, applyLocaleFromNativeLanguage, initFromUser }
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
