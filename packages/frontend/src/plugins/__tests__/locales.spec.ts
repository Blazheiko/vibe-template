import { afterEach, describe, expect, it, vi } from 'vitest'
import { SHIPPED_LOCALE_CODES } from 'shared/enums'
import en from '@/locales/en'
import pl from '@/locales/pl'
import uk from '@/locales/uk'
import { i18n, loadLocale } from '../i18n'
import type { SupportedLocale } from '../i18n'

// feat-083 (O): the interface languages that ship are real translations, nothing else pretends to
// be one, and choosing a language can never leave the interface without text.

interface Tree {
    [key: string]: string | Tree
}

function flatten(tree: Tree, prefix = ''): Record<string, string> {
    return Object.entries(tree).reduce<Record<string, string>>((out, [key, value]) => {
        const path = prefix === '' ? key : `${prefix}.${key}`
        if (typeof value === 'string') out[path] = value
        else Object.assign(out, flatten(value, path))
        return out
    }, {})
}

const placeholders = (text: string): string[] =>
    [...text.matchAll(/\{[^}]+\}/g)].map((match) => match[0]).sort()

const english = flatten(en)
const translations = { uk: flatten(uk), pl: flatten(pl) }

afterEach(() => {
    vi.restoreAllMocks()
    i18n.global.locale.value = 'en'
})

describe('the locale files', () => {
    it('are exactly the languages that ship: no stub files for languages nobody translated', () => {
        const files = Object.keys(import.meta.glob('@/locales/*.ts'))
            .map((path) => /\/([a-z]+)\.ts$/.exec(path)?.[1])
            .sort()
        expect(files).toEqual([...SHIPPED_LOCALE_CODES].sort())
    })

    it.each(['uk', 'pl'] as const)('%s has every key of English, and no other', (code) => {
        expect(Object.keys(translations[code]).sort()).toEqual(Object.keys(english).sort())
    })

    it.each(['uk', 'pl'] as const)('%s keeps the placeholders of every message', (code) => {
        for (const [path, text] of Object.entries(english)) {
            expect(placeholders(translations[code][path] ?? ''), `${code}: ${path}`).toEqual(
                placeholders(text),
            )
        }
    })

    it.each(['uk', 'pl'] as const)('%s is translated, not a copy of English', (code) => {
        const same = Object.entries(english).filter(
            ([path, text]) => translations[code][path] === text,
        )
        // Brand name, the example phone number and the code mask are the same in every language
        expect(same.map(([path]) => path).sort()).toEqual(
            [
                'auth.phonePlaceholder',
                'auth.verificationCodePlaceholder',
                'auth.emailPlaceholder',
                'login.heroTitle',
            ].sort(),
        )
        expect(Object.values(translations[code]).every((text) => text.trim() !== '')).toBe(true)
    })
})

describe('loadLocale', () => {
    it('is English at once, without importing anything', async () => {
        const importer = vi.fn()
        expect(await loadLocale('en', importer)).toBe('en')
        expect(importer).not.toHaveBeenCalled()
    })

    it.each(['uk', 'pl'] as const)('loads %s and hands its messages to vue-i18n', async (code) => {
        expect(await loadLocale(code)).toBe(code)
        expect(i18n.global.getLocaleMessage(code)).toMatchObject({
            common: { save: translations[code]['common.save'] },
        })
    })

    it('falls back to English when the file does not load, and says so', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
        const broken = vi
            .fn()
            .mockRejectedValue(new Error('Failed to fetch dynamically imported module'))
        expect(await loadLocale('uk', broken)).toBe('en')
        expect(warn).toHaveBeenCalledTimes(1)
        expect(String(warn.mock.calls[0]?.[0])).toContain('"uk"')
    })

    it('falls back to English for a language with no file at all', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined)
        expect(await loadLocale('ru' as SupportedLocale)).toBe('en')
    })

    it('fills what a translation lacks from English', async () => {
        const partial = { default: { common: { save: 'Zapisz' } } }
        await loadLocale('pl', () => Promise.resolve(partial))
        const messages = flatten(i18n.global.getLocaleMessage<Tree>('pl'))
        expect(messages['common.save']).toBe('Zapisz')
        expect(messages['common.cancel']).toBe(english['common.cancel'])
    })
})
