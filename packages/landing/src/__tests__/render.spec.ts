import { describe, expect, it } from 'vitest'
import { fillTemplate, renderPage } from '../entry-server'
import { matchPath } from '../routes'
import { CONTENT, LOCALES } from '../pages'

const ctx = { appUrl: 'https://app.vibe.dev', siteUrl: 'https://vibe.dev' }

describe('renderPage', () => {
    it.each(LOCALES)('%s: both buttons lead to the app', async (locale) => {
        const { body, lang } = await renderPage(locale, ctx)
        expect(lang).toBe(locale)
        expect(body).toContain('href="https://app.vibe.dev/login" data-testid="cta-login"')
        expect(body).toContain('href="https://app.vibe.dev/register" data-testid="cta-register"')
        expect(body).toContain(CONTENT[locale].hero.register)
        expect(body.match(/<h1\b/g)).toHaveLength(1)
    })

    it('links the privacy policy and terms of the app', async () => {
        const { body } = await renderPage('en', ctx)
        expect(body).toContain('href="https://app.vibe.dev/privacy-policy"')
        expect(body).toContain('href="https://app.vibe.dev/terms"')
    })

    it('marks the current locale in the switcher', async () => {
        const { body } = await renderPage('uk', ctx)
        expect(body).toMatch(/href="\/uk\/"[^>]*aria-current="page"/)
        expect(body).not.toMatch(/href="\/pl\/"[^>]*aria-current="page"/)
    })

    it('puts canonical and every alternate on the landing origin', async () => {
        const { head } = await renderPage('pl', ctx)
        expect(head).toContain('<link rel="canonical" href="https://vibe.dev/pl/" />')
        expect(head).toContain('<link rel="alternate" hreflang="uk" href="https://vibe.dev/uk/" />')
        expect(head).toContain(
            '<link rel="alternate" hreflang="x-default" href="https://vibe.dev/" />',
        )
    })

    it('renders a 404 page in every locale that is not indexed', async () => {
        const { head, body } = await renderPage('not-found', ctx)
        expect(head).toContain('noindex')
        expect(body).toContain('data-page="not-found"')
        for (const locale of LOCALES) expect(body).toContain(CONTENT[locale].notFound.title)
    })
})

describe('fillTemplate', () => {
    const template =
        '<html lang="en"><head><!--landing-head--></head><body><!--landing-app--></body></html>'

    it('fills the markers and the language', () => {
        expect(
            fillTemplate(template, { lang: 'uk', head: '<title>t</title>', body: '<p>$&</p>' }),
        ).toBe('<html lang="uk"><head><title>t</title></head><body><p>$&</p></body></html>')
    })

    it('fails on a template without a marker', () => {
        expect(() =>
            fillTemplate('<html lang="en"></html>', { lang: 'en', head: '', body: '' }),
        ).toThrow('no <!--landing-head-->')
    })
})

describe('content', () => {
    it.each(LOCALES)('%s has no empty text', (locale) => {
        const walk = (value: unknown): string[] =>
            typeof value === 'string'
                ? [value]
                : Array.isArray(value)
                  ? value.flatMap(walk)
                  : typeof value === 'object' && value !== null
                    ? Object.values(value).flatMap(walk)
                    : []
        expect(walk(CONTENT[locale]).filter((text) => text.trim() === '')).toEqual([])
    })
})

describe('matchPath', () => {
    it.each([
        ['/', { kind: 'page', page: 'en' }],
        ['/index.html', { kind: 'page', page: 'en' }],
        ['/uk/', { kind: 'page', page: 'uk' }],
        ['/pl/index.html', { kind: 'page', page: 'pl' }],
        ['/uk', { kind: 'redirect', location: '/uk/' }],
        ['/de/', { kind: 'not-found' }],
        ['/login', { kind: 'not-found' }],
    ])('%s', (path, expected) => {
        expect(matchPath(path)).toEqual(expected)
    })
})
