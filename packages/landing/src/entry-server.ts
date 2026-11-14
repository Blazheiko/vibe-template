import { createSSRApp } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { PRODUCT } from 'shared/product'
import App from './App.vue'
import { CONTENT, LOCALE_PATHS, LOCALES, type PageId } from './pages'

/**
 * The one rendering path of the landing. The build prerenders every page with it
 * (build/landing-plugin.ts, after `vite build --ssr`), and the dev server renders the requested
 * page with it on each request, so dev and production HTML are the same markup. There is no
 * client entry: the built pages carry no JavaScript.
 */

export interface RenderContext {
    /** Origin of the application, without a trailing slash. */
    readonly appUrl: string
    /** Origin of the landing, without a trailing slash. */
    readonly siteUrl: string
}

export interface RenderedPage {
    readonly lang: string
    /** Tags for <head>: title, description, canonical, alternates, social cards. */
    readonly head: string
    /** The rendered application, for the #app element. */
    readonly body: string
}

const escapeHtml = (value: string): string =>
    value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')

const OG_LOCALES = { en: 'en_US', uk: 'uk_UA', pl: 'pl_PL' } as const

function headFor(page: PageId, ctx: RenderContext): string {
    if (page === 'not-found') {
        const title = `${CONTENT.en.notFound.title} — ${PRODUCT.name}`
        return [
            `<title>${escapeHtml(title)}</title>`,
            '<meta name="robots" content="noindex" />',
        ].join('\n        ')
    }
    const content = CONTENT[page]
    const url = `${ctx.siteUrl}${LOCALE_PATHS[page]}`
    const title = `${PRODUCT.name} — ${content.tagline}`
    const alternates = LOCALES.map(
        (locale) =>
            `<link rel="alternate" hreflang="${locale}" href="${escapeHtml(`${ctx.siteUrl}${LOCALE_PATHS[locale]}`)}" />`,
    )
    return [
        `<title>${escapeHtml(title)}</title>`,
        `<meta name="description" content="${escapeHtml(content.description)}" />`,
        `<link rel="canonical" href="${escapeHtml(url)}" />`,
        ...alternates,
        `<link rel="alternate" hreflang="x-default" href="${escapeHtml(`${ctx.siteUrl}/`)}" />`,
        '<meta property="og:type" content="website" />',
        `<meta property="og:site_name" content="${escapeHtml(PRODUCT.name)}" />`,
        `<meta property="og:title" content="${escapeHtml(title)}" />`,
        `<meta property="og:description" content="${escapeHtml(content.description)}" />`,
        `<meta property="og:url" content="${escapeHtml(url)}" />`,
        `<meta property="og:locale" content="${OG_LOCALES[page]}" />`,
        `<meta property="og:image" content="${escapeHtml(`${ctx.siteUrl}/og-image.png`)}" />`,
        '<meta name="twitter:card" content="summary" />',
    ].join('\n        ')
}

export async function renderPage(page: PageId, ctx: RenderContext): Promise<RenderedPage> {
    const app = createSSRApp(App, { page, appUrl: ctx.appUrl })
    const body = await renderToString(app)
    return { lang: page === 'not-found' ? 'en' : page, head: headFor(page, ctx), body }
}

/** Puts a rendered page into the index.html template (dev: transformed by Vite; build: dist/). */
export function fillTemplate(template: string, rendered: RenderedPage): string {
    const parts: readonly (readonly [string, string])[] = [
        ['<html lang="en">', `<html lang="${rendered.lang}">`],
        ['<!--landing-head-->', rendered.head],
        ['<!--landing-app-->', rendered.body],
    ]
    let html = template
    for (const [marker, value] of parts) {
        if (!html.includes(marker)) throw new Error(`index.html: no ${marker}`)
        // A function, so `$` in the rendered markup is not a replacement pattern.
        html = html.replace(marker, () => value)
    }
    return html
}
