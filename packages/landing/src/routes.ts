import { LOCALES, type Locale } from './content/types'

// Routes only, no texts: build/ (part of the Vite config) imports this module, and a config
// dependency restarts the dev server on change. Texts stay in pages.ts, under HMR.

export { LOCALES, type Locale }

/** A page of the landing: one per locale, plus the 404 page (dist/404.html). */
export type PageId = Locale | 'not-found'

/** Path of each locale page, from the site root. English is the root (x-default). */
export const LOCALE_PATHS: Readonly<Record<Locale, string>> = { en: '/', uk: '/uk/', pl: '/pl/' }

/** Output file of a page inside dist/. */
export const pageFile = (page: PageId): string =>
    page === 'not-found' ? '404.html' : `${LOCALE_PATHS[page].slice(1)}index.html`

export type PathMatch =
    | { readonly kind: 'page'; readonly page: Locale }
    | { readonly kind: 'redirect'; readonly location: string }
    | { readonly kind: 'not-found' }

/** What a GET of `pathname` serves, the same way nginx does (`try_files $uri $uri/ =404`). */
export function matchPath(pathname: string): PathMatch {
    for (const locale of LOCALES) {
        const path = LOCALE_PATHS[locale]
        if (pathname === path || (path === '/' && pathname === '/index.html')) {
            return { kind: 'page', page: locale }
        }
        if (path !== '/' && (pathname === path.slice(0, -1) || pathname === `${path}index.html`)) {
            return pathname.endsWith('index.html')
                ? { kind: 'page', page: locale }
                : { kind: 'redirect', location: path }
        }
    }
    return { kind: 'not-found' }
}
