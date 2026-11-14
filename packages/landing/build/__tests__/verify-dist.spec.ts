import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fillTemplate, renderPage } from '../../src/entry-server'
import { LOCALES, pageFile } from '../../src/routes'
import { robotsTxt, sitemapXml } from '../site-files'
import type { LandingUrls } from '../urls'
import { verifyDist } from '../verify-dist'

const TEMPLATE =
    '<!doctype html>\n<html lang="en">\n<head>\n<!--landing-head-->\n<link rel="stylesheet" crossorigin href="/assets/index-abc.css">\n</head>\n<body><div id="app"><!--landing-app--></div></body>\n</html>\n'

const dirs: string[] = []
afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A dist/ as the build writes it, for these addresses. */
async function buildDist(urls: LandingUrls): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), 'landing-dist-'))
    dirs.push(dir)
    for (const page of [...LOCALES, 'not-found'] as const) {
        const file = join(dir, pageFile(page))
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, fillTemplate(TEMPLATE, await renderPage(page, urls)))
    }
    writeFileSync(join(dir, 'sitemap.xml'), sitemapXml(urls.siteUrl))
    writeFileSync(join(dir, 'robots.txt'), robotsTxt(urls.siteUrl))
    for (const file of ['favicon.svg', 'og-image.png']) writeFileSync(join(dir, file), '')
    return dir
}

const LOCAL: LandingUrls = {
    appUrl: 'http://localhost:5173',
    siteUrl: 'http://localhost:5175',
    strict: false,
}
const PUBLIC: LandingUrls = {
    appUrl: 'https://app.vibe.dev',
    siteUrl: 'https://vibe.dev',
    strict: true,
}

const edit = (dir: string, file: string, change: (text: string) => string): void => {
    writeFileSync(join(dir, file), change(readFileSync(join(dir, file), 'utf8')))
}

describe('verifyDist', () => {
    it('passes a local build', async () => {
        expect(verifyDist(await buildDist(LOCAL), LOCAL)).toEqual([])
    })

    it('passes a strict build: the sitemap namespace is not an address', async () => {
        const dir = await buildDist(PUBLIC)
        expect(readFileSync(join(dir, 'sitemap.xml'), 'utf8')).toContain(
            'xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"',
        )
        expect(verifyDist(dir, PUBLIC)).toEqual([])
    })

    it('in strict mode flags every local address', async () => {
        const dir = await buildDist(LOCAL)
        const problems = verifyDist(dir, { ...LOCAL, strict: true })
        expect(problems).toContain('strict: http://localhost:5175/uk/ must use https')
        expect(problems).toContain('strict: http://localhost:5173/login must use https')
        expect(problems).toContain('strict: http://localhost:5175/sitemap.xml must use https')
    })

    it('flags a wrong canonical, a lost button and a script', async () => {
        const dir = await buildDist(PUBLIC)
        edit(dir, 'uk/index.html', (html) =>
            html
                .replace('href="https://vibe.dev/uk/" />', 'href="https://vibe.dev/" />')
                .replace('</body>', '<script src="/x.js"></script></body>'),
        )
        edit(dir, 'pl/index.html', (html) => html.replaceAll('data-testid="cta-login"', ''))
        const problems = verifyDist(dir, PUBLIC)
        expect(problems).toContain('uk/index.html: canonical is not https://vibe.dev/uk/')
        expect(problems).toContain('uk/index.html: has <script>, the pages carry no JavaScript')
        expect(problems).toContain('pl/index.html: no cta-login button')
    })

    it('flags a missing 404 page and a wrong sitemap', async () => {
        const dir = await buildDist(PUBLIC)
        rmSync(join(dir, '404.html'))
        edit(dir, 'sitemap.xml', (xml) =>
            xml.replace('https://vibe.dev/pl/', 'https://vibe.dev/de/'),
        )
        const problems = verifyDist(dir, PUBLIC)
        expect(problems).toContain('404.html: missing')
        expect(problems.some((problem) => problem.startsWith('sitemap.xml: <loc> are'))).toBe(true)
    })
})
