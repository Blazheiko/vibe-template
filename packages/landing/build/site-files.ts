import { LOCALE_PATHS, LOCALES } from '../src/routes'

/** sitemap.xml: one <loc> per locale page. The xmlns is the protocol's identifier, not a link. */
export function sitemapXml(siteUrl: string): string {
    const urls = LOCALES.map(
        (locale) => `    <url>\n        <loc>${siteUrl}${LOCALE_PATHS[locale]}</loc>\n    </url>`,
    )
    return [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
        ...urls,
        '</urlset>',
        '',
    ].join('\n')
}

export function robotsTxt(siteUrl: string): string {
    return `User-agent: *\nAllow: /\n\nSitemap: ${siteUrl}/sitemap.xml\n`
}
