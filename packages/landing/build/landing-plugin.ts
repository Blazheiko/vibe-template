import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin, ResolvedConfig, ViteDevServer } from 'vite'
import { LOCALES, matchPath, pageFile, type PageId } from '../src/routes'
import { robotsTxt, sitemapXml } from './site-files'
import type { LandingUrls } from './urls'
import { verifyDist } from './verify-dist'

/**
 * The two ways src/entry-server.ts renders pages (docs/plan/landing-plan.md, "Рендеринг у dev"):
 *
 * - `vite` (dev): a middleware renders the requested page on every request through
 *   ssrLoadModule, into index.html transformed by Vite (which adds /@vite/client for CSS HMR).
 *   A change to a module of the SSR graph (texts, components) reloads the page.
 * - `vite build`: the package script runs `vite build --ssr src/entry-server.ts` first, then the
 *   client build, which only processes index.html and the CSS. When it closes, this plugin
 *   renders every page into dist/ with the SSR bundle, writes sitemap.xml and robots.txt, and
 *   checks the result (build/verify-dist.ts).
 */

interface EntryServer {
    renderPage(
        page: PageId,
        ctx: { appUrl: string; siteUrl: string },
    ): Promise<{ lang: string; head: string; body: string }>
    fillTemplate(template: string, rendered: { lang: string; head: string; body: string }): string
}

const SSR_OUT_DIR = 'dist-ssr'

/** Requests Vite itself answers: its client, modules, sources, files with an extension. */
const isViteRequest = (pathname: string): boolean =>
    pathname.startsWith('/@') ||
    pathname.startsWith('/src/') ||
    pathname.startsWith('/node_modules/') ||
    pathname.startsWith('/__') ||
    /\.[a-z0-9]+$/i.test(pathname.split('/').pop() ?? '')

async function devRender(
    server: ViteDevServer,
    urls: LandingUrls,
    req: IncomingMessage,
    res: ServerResponse,
): Promise<boolean> {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false
    const url = new URL(req.url ?? '/', 'http://localhost')
    const match = matchPath(url.pathname)
    if (match.kind === 'not-found' && isViteRequest(url.pathname)) return false
    if (match.kind === 'redirect') {
        res.statusCode = 301
        res.setHeader('Location', match.location)
        res.end()
        return true
    }
    const page: PageId = match.kind === 'page' ? match.page : 'not-found'
    const template = await server.transformIndexHtml(
        url.pathname,
        readFileSync(join(server.config.root, 'index.html'), 'utf8'),
    )
    const entry = (await server.ssrLoadModule('/src/entry-server.ts')) as EntryServer
    const html = entry.fillTemplate(template, await entry.renderPage(page, urls))
    res.statusCode = page === 'not-found' ? 404 : 200
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache')
    res.end(req.method === 'HEAD' ? undefined : html)
    return true
}

async function prerender(config: ResolvedConfig, urls: LandingUrls): Promise<void> {
    const outDir = join(config.root, config.build.outDir)
    const ssrEntry = join(config.root, SSR_OUT_DIR, 'entry-server.js')
    if (!existsSync(ssrEntry)) {
        throw new Error(
            `${ssrEntry} is missing: run \`vite build --ssr src/entry-server.ts --outDir ${SSR_OUT_DIR}\` first (pnpm --filter landing build does)`,
        )
    }
    const entry = (await import(pathToFileURL(ssrEntry).href)) as EntryServer
    const template = readFileSync(join(outDir, 'index.html'), 'utf8')
    for (const page of [...LOCALES, 'not-found'] as const) {
        const file = join(outDir, pageFile(page))
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, entry.fillTemplate(template, await entry.renderPage(page, urls)))
    }
    writeFileSync(join(outDir, 'sitemap.xml'), sitemapXml(urls.siteUrl))
    writeFileSync(join(outDir, 'robots.txt'), robotsTxt(urls.siteUrl))
    rmSync(join(config.root, SSR_OUT_DIR), { recursive: true, force: true })

    const problems = verifyDist(outDir, urls)
    if (problems.length > 0) {
        throw new Error(`The built landing failed its checks:\n  - ${problems.join('\n  - ')}`)
    }
    config.logger.info(
        `landing: ${String(LOCALES.length)} pages and 404.html for ${urls.siteUrl}, buttons to ${urls.appUrl}${urls.strict ? ' (strict)' : ''}`,
    )
}

export function landing(urls: LandingUrls): Plugin {
    let config: ResolvedConfig
    let devServer: ViteDevServer | undefined
    return {
        name: 'landing',
        configResolved(resolved) {
            config = resolved
        },
        configureServer(server) {
            devServer = server
            server.middlewares.use((req, res, next) => {
                devRender(server, urls, req, res)
                    .then((handled) => {
                        if (!handled) next()
                    })
                    .catch((error: unknown) => {
                        if (error instanceof Error) server.ssrFixStacktrace(error)
                        next(error)
                    })
            })
        },
        // Texts and components live only in the SSR graph: the browser has no module to swap,
        // so a change there reloads the page, which renders again with the fresh module.
        hotUpdate({ modules }) {
            if (this.environment.name !== 'ssr' || modules.length === 0) return
            devServer?.environments.client.hot.send({ type: 'full-reload' })
        },
        async closeBundle() {
            if (config.command !== 'build' || config.build.ssr !== false) return
            await prerender(config, urls)
        },
    }
}
