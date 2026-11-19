import { afterEach, describe, expect, it, vi } from 'vitest'
import { i18n } from '@/plugins/i18n'
import { initLocaleStandalone, supportLanguage } from '../useLocale'

// feat-083 (O): the language of the interface follows the language of the browser, among the ones
// that ship.

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    i18n.global.locale.value = 'en'
})

async function startIn(language: string): Promise<string> {
    vi.stubGlobal('navigator', { language })
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await initLocaleStandalone()
    return i18n.global.locale.value
}

describe('initLocaleStandalone', () => {
    it.each([
        ['uk-UA', 'uk'],
        ['uk', 'uk'],
        ['pl-PL', 'pl'],
        ['PL', 'pl'],
        ['en-US', 'en'],
        // known to the app (the Support AI speaks them), not translated in the interface
        ['ru-RU', 'en'],
        ['de-DE', 'en'],
        ['ja', 'en'],
        // unknown
        ['tlh', 'en'],
        ['', 'en'],
    ])('a browser in %j gets %j', async (language, expected) => {
        expect(await startIn(language)).toBe(expected)
    })
})

describe('supportLanguage', () => {
    it.each([
        ['ru-RU', 'ru'],
        ['de-DE', 'de'],
        ['uk-UA', 'uk'],
        ['pt-BR', 'pt'],
        // not a language the app recognises
        ['tlh', 'en'],
    ])(
        'a browser in %j asks the Support AI for %j, whatever the interface speaks',
        (language, expected) => {
            vi.stubGlobal('navigator', { language })
            expect(supportLanguage()).toBe(expected)
        },
    )
})

// feat-232 T12 (Р7): the profile language, then the browser's, then English.
describe('applyLocalePreference', () => {
    async function applyIn(browser: string, profileLocale: string | null): Promise<string> {
        vi.stubGlobal('navigator', { language: browser })
        vi.spyOn(console, 'warn').mockImplementation(() => undefined)
        const { applyLocalePreference } = await import('../useLocale')
        await applyLocalePreference(profileLocale)
        return i18n.global.locale.value
    }

    it('the profile language wins over the browser', async () => {
        expect(await applyIn('pl-PL', 'uk')).toBe('uk')
    })

    it('null goes back to the browser language', async () => {
        await applyIn('pl-PL', 'uk')
        expect(await applyIn('pl-PL', null)).toBe('pl')
    })

    it('a language the interface does not ship is the browser language, then English', async () => {
        expect(await applyIn('pl-PL', 'de')).toBe('pl')
        expect(await applyIn('ja', 'de')).toBe('en')
    })

    it('a language whose file does not load shows English', async () => {
        vi.stubGlobal('navigator', { language: 'en-US' })
        vi.spyOn(console, 'warn').mockImplementation(() => undefined)
        const plugin = await import('@/plugins/i18n')
        expect(await plugin.loadLocale('uk', () => Promise.reject(new Error('offline')))).toBe('en')
    })

    it('of two quick switches the later one wins', async () => {
        vi.stubGlobal('navigator', { language: 'en-US' })
        const { applyLocalePreference } = await import('../useLocale')
        const first = applyLocalePreference('uk')
        const second = applyLocalePreference('pl')
        await Promise.all([first, second])
        expect(i18n.global.locale.value).toBe('pl')
    })
})
