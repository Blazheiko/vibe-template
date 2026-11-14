import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LOCALE_PATHS, LOCALES, pageFile, type PageId } from '../src/routes'
import { productionProblem, type LandingUrls } from './urls'

/**
 * Checks the built dist/ against the address contract. Runs at the end of every `vite build`
 * (build/landing-plugin.ts), so a broken page fails the build in CI and in the Docker image.
 * Returns the problems; an empty list means the build is good.
 */

const REQUIRED_FILES = ['robots.txt', 'sitemap.xml', 'favicon.svg', 'og-image.png']

const attr = (tag: string, name: string): string | undefined =>
    new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1]

const tags = (html: string, name: string): string[] =>
    html.match(new RegExp(`<${name}\\b[^>]*>`, 'g')) ?? []

/** Attribute values HTML escaping changes; the addresses here never contain anything else. */
const unescape = (value: string): string => value.replace(/&amp;/g, '&')

/** Every absolute address a page publishes: these, and only these, follow the strict rules. */
function pageAddresses(html: string): string[] {
    const links = tags(html, 'link')
        .filter((tag) => /\srel="(canonical|alternate)"/.test(tag))
        .map((tag) => attr(tag, 'href'))
    const metas = tags(html, 'meta')
        .filter((tag) => /\sproperty="og:(url|image)"/.test(tag))
        .map((tag) => attr(tag, 'content'))
    const ctas = tags(html, 'a')
        .filter((tag) => /\sdata-testid="cta-(login|register)"/.test(tag))
        .map((tag) => attr(tag, 'href'))
    return [...links, ...metas, ...ctas]
        .filter((value): value is string => value !== undefined)
        .map(unescape)
}

function checkCommon(page: PageId, html: string, problems: string[]): void {
    const where = pageFile(page)
    if (html.includes('<!--landing-')) problems.push(`${where}: a template marker is left`)
    if (html.includes('/@vite/client'))
        problems.push(`${where}: the Vite dev client is in the page`)
    const scripts = tags(html, 'script').filter(
        (tag) => attr(tag, 'type') !== 'application/ld+json',
    )
    if (scripts.length > 0) problems.push(`${where}: has <script>, the pages carry no JavaScript`)
    const styles = tags(html, 'link').filter((tag) => /\srel="stylesheet"/.test(tag))
    if (!styles.some((tag) => /^\/assets\/[^"]+\.css$/.test(attr(tag, 'href') ?? ''))) {
        problems.push(`${where}: no stylesheet from /assets/`)
    }
    const h1 = html.match(/<h1\b/g)?.length ?? 0
    if (h1 !== 1) problems.push(`${where}: ${h1} <h1> elements, expected 1`)
}

function checkLocalePage(
    locale: (typeof LOCALES)[number],
    html: string,
    urls: LandingUrls,
    problems: string[],
): void {
    const where = pageFile(locale)
    const expect = (ok: boolean, message: string): void => {
        if (!ok) problems.push(`${where}: ${message}`)
    }
    const url = `${urls.siteUrl}${LOCALE_PATHS[locale]}`
    expect(html.includes(`<html lang="${locale}">`), `<html lang="${locale}"> missing`)
    expect(html.includes(`<link rel="canonical" href="${url}" />`), `canonical is not ${url}`)
    expect(html.includes(`<meta property="og:url" content="${url}" />`), `og:url is not ${url}`)
    for (const other of LOCALES) {
        const href = `${urls.siteUrl}${LOCALE_PATHS[other]}`
        expect(
            html.includes(`<link rel="alternate" hreflang="${other}" href="${href}" />`),
            `hreflang ${other} is not ${href}`,
        )
    }
    expect(
        html.includes(`<link rel="alternate" hreflang="x-default" href="${urls.siteUrl}/" />`),
        'hreflang x-default missing',
    )
    for (const [id, path] of [
        ['cta-login', '/login'],
        ['cta-register', '/register'],
    ] as const) {
        const hrefs = tags(html, 'a')
            .filter((tag) => tag.includes(`data-testid="${id}"`))
            .map((tag) => attr(tag, 'href'))
        expect(hrefs.length > 0, `no ${id} button`)
        expect(
            hrefs.every((href) => href === `${urls.appUrl}${path}`),
            `${id} does not lead to ${urls.appUrl}${path}`,
        )
    }
}

export function verifyDist(distDir: string, urls: LandingUrls): string[] {
    const problems: string[] = []
    const read = (file: string): string | null => {
        const path = join(distDir, file)
        if (!existsSync(path)) {
            problems.push(`${file}: missing`)
            return null
        }
        return readFileSync(path, 'utf8')
    }
    const addresses: string[] = []

    for (const page of [...LOCALES, 'not-found'] as const) {
        const html = read(pageFile(page))
        if (html === null) continue
        checkCommon(page, html, problems)
        if (page === 'not-found') {
            if (!html.includes('data-page="not-found"')) problems.push('404.html: not the 404 page')
            if (!html.includes('<meta name="robots" content="noindex" />')) {
                problems.push('404.html: no robots noindex')
            }
        } else {
            checkLocalePage(page, html, urls, problems)
        }
        addresses.push(...pageAddresses(html))
    }
    for (const file of REQUIRED_FILES) {
        if (!existsSync(join(distDir, file))) problems.push(`${file}: missing`)
    }

    const sitemap = existsSync(join(distDir, 'sitemap.xml'))
        ? readFileSync(join(distDir, 'sitemap.xml'), 'utf8')
        : ''
    const locs = [...sitemap.matchAll(/<loc>([^<]*)<\/loc>/g)].map((match) => match[1])
    const expectedLocs = LOCALES.map((locale) => `${urls.siteUrl}${LOCALE_PATHS[locale]}`)
    if (sitemap !== '' && locs.join(' ') !== expectedLocs.join(' ')) {
        problems.push(
            `sitemap.xml: <loc> are ${locs.join(', ')}, expected ${expectedLocs.join(', ')}`,
        )
    }
    addresses.push(...locs)

    const robots = existsSync(join(distDir, 'robots.txt'))
        ? readFileSync(join(distDir, 'robots.txt'), 'utf8')
        : ''
    const sitemapLine = /^Sitemap: (.+)$/m.exec(robots)?.[1]
    if (robots !== '' && sitemapLine !== `${urls.siteUrl}/sitemap.xml`) {
        problems.push(`robots.txt: Sitemap is ${sitemapLine ?? 'missing'}`)
    }
    if (sitemapLine !== undefined) addresses.push(sitemapLine)

    if (urls.strict) {
        for (const address of new Set(addresses)) {
            const problem = productionProblem(address)
            if (problem !== null) problems.push(`strict: ${address} ${problem}`)
        }
    }
    return problems
}
