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
