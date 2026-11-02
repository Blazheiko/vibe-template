import { createI18n } from 'vue-i18n'
import en from '@/locales/en'
import { SHIPPED_LOCALE_CODES } from 'shared/enums'

// Only the languages that have a file in `locales/`; any other language shows English.
export const SUPPORTED_LOCALES = SHIPPED_LOCALE_CODES
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number]
type LocaleSchema = typeof en
type LocaleMessageTree = Record<string, unknown>

function isLocaleMessageTree(value: unknown): value is LocaleMessageTree {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function mergeLocaleMessages(
    fallback: LocaleMessageTree,
    locale: LocaleMessageTree,
): LocaleMessageTree {
    const merged: LocaleMessageTree = { ...fallback }

    Object.entries(locale).forEach(([key, value]) => {
        const fallbackValue = merged[key]
        if (isLocaleMessageTree(fallbackValue) && isLocaleMessageTree(value)) {
            merged[key] = mergeLocaleMessages(fallbackValue, value)
            return
        }
        merged[key] = value
    })

    return merged
}

const messages: Partial<Record<SupportedLocale, LocaleSchema>> = {
    en,
}

export const i18n = createI18n({
    legacy: false,
    locale: 'en',
    fallbackLocale: 'en',
    messages,
})

/**
 * Makes the messages of `locale` available and returns the locale that is now usable: `locale`
 * itself, or `'en'` when its file is missing or does not load (a failed chunk, an offline
 * start), so that choosing a language can never leave the interface without text.
 *
 * @param importLocale replaces the dynamic import, for a test
 */
export async function loadLocale(
    locale: SupportedLocale,
    importLocale: (code: SupportedLocale) => Promise<{ default: unknown }> = (code) =>
        import(`@/locales/${code}.ts`) as Promise<{ default: unknown }>,
): Promise<SupportedLocale> {
    if (locale === 'en') return 'en'

    try {
        const messages = await importLocale(locale)
        i18n.global.setLocaleMessage(
            locale,
            mergeLocaleMessages(
                en as LocaleMessageTree,
                messages.default as LocaleMessageTree,
            ) as LocaleSchema,
        )
        return locale
    } catch (error) {
        console.warn(`[i18n] Could not load the "${locale}" messages; showing English`, error)
        return 'en'
    }
}
