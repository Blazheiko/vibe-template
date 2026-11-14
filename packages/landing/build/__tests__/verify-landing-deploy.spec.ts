import { spawn, execFileSync } from 'node:child_process'
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs'
import { createServer, type Server } from 'node:https'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fillTemplate, renderPage } from '../../src/entry-server'
import { LOCALES, pageFile } from '../../src/routes'
import { robotsTxt, sitemapXml } from '../site-files'

/**
 * scripts/verify-landing-deploy.sh against a stand-in deployment: an https server that behaves
 * like packages/landing/nginx (a real 404 with 404.html, the security headers) and an app that
 * answers /login. Public-looking names (landing.vibe.dev, app.vibe.dev) point at 127.0.0.1
 * through the script's --resolve, so the strict address rules apply as in production.
 */

const SCRIPT = fileURLToPath(
    new URL('../../../../scripts/verify-landing-deploy.sh', import.meta.url),
)
const TEMPLATE =
    '<!doctype html>\n<html lang="en">\n<head>\n<!--landing-head-->\n<link rel="stylesheet" crossorigin href="/assets/index-abc.css">\n</head>\n<body><div id="app"><!--landing-app--></div></body>\n</html>\n'
const HEADERS = {
    'Content-Security-Policy': "default-src 'self'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
}
const TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.xml': 'text/xml',
    '.txt': 'text/plain',
}

let work = ''
let dist = ''
let site = ''
let app = ''
let resolve: string[] = []
/** When true the site answers an unknown path like a SPA: the home page with 200. */
let spaFallback = false
const servers: Server[] = []

const listen = (server: Server): Promise<number> =>
    new Promise((done) => {
        server.listen(0, '127.0.0.1', () => {
            done((server.address() as AddressInfo).port)
        })
    })

beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'landing-deploy-'))
    dist = join(work, 'dist')
    execFileSync(
        'openssl',
        [
            'req',
            '-x509',
            '-newkey',
            'rsa:2048',
            '-nodes',
            '-days',
            '1',
            '-subj',
            '/CN=vibe.dev',
            '-keyout',
            join(work, 'key.pem'),
            '-out',
            join(work, 'cert.pem'),
        ],
        { stdio: 'ignore' },
    )
    const tls = {
        key: readFileSync(join(work, 'key.pem')),
        cert: readFileSync(join(work, 'cert.pem')),
    }

    const siteServer = createServer(tls, (req, res) => {
        const path = new URL(req.url ?? '/', 'https://x').pathname
        const file = join(dist, path.endsWith('/') ? `${path}index.html` : path)
        if (existsSync(file) && statSync(file).isFile()) {
            res.writeHead(200, {
                ...HEADERS,
                'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
            })
            res.end(readFileSync(file))
            return
        }
        const [status, body] = spaFallback ? [200, 'index.html'] : [404, '404.html']
        res.writeHead(status, { ...HEADERS, 'Content-Type': TYPES['.html'] })
        res.end(readFileSync(join(dist, body)))
    })
    const appServer = createServer(tls, (req, res) => {
        res.writeHead(req.url === '/login' ? 200 : 404, { 'Content-Type': 'text/html' })
        res.end('<h1>app</h1>')
    })
    servers.push(siteServer, appServer)
    const [sitePort, appPort] = [await listen(siteServer), await listen(appServer)]
    site = `https://landing.vibe.dev:${String(sitePort)}`
    app = `https://app.vibe.dev:${String(appPort)}`
    resolve = [
        '--resolve',
        `landing.vibe.dev:${String(sitePort)}:127.0.0.1`,
        '--resolve',
        `app.vibe.dev:${String(appPort)}:127.0.0.1`,
    ]
})

afterAll(() => {
    for (const server of servers) server.close()
    rmSync(work, { recursive: true, force: true })
})

/** A dist/ as the build writes it for these addresses, then `change` applied to every page. */
async function deploy(change: (html: string) => string = (html) => html): Promise<void> {
    rmSync(dist, { recursive: true, force: true })
    const urls = { appUrl: app, siteUrl: site }
    for (const page of [...LOCALES, 'not-found'] as const) {
        const file = join(dist, pageFile(page))
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, change(fillTemplate(TEMPLATE, await renderPage(page, urls))))
    }
    writeFileSync(join(dist, 'sitemap.xml'), sitemapXml(site))
    writeFileSync(join(dist, 'robots.txt'), robotsTxt(site))
}

/** Runs the script asynchronously: the servers above live in this process. */
const verify = (): Promise<{ code: number | null; output: string }> =>
    new Promise((done) => {
        const child = spawn('bash', [SCRIPT, '--insecure', ...resolve, site, app])
        let output = ''
        child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()))
        child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()))
        child.on('close', (code) => {
            done({ code, output })
        })
    })

describe('verify-landing-deploy.sh', { timeout: 60_000 }, () => {
    it('passes a correct deployment in strict mode', async () => {
        spaFallback = false
        await deploy()
        const { code, output } = await verify()
        expect(output).toMatch(/all \d+ checks passed/)
        expect(code).toBe(0)
    })

    it('fails on an og:image on another, local host', async () => {
        spaFallback = false
        await deploy((html) =>
            html.replace(
                `content="${site}/og-image.png"`,
                'content="http://localhost:9999/og-image.png"',
            ),
        )
        const { code, output } = await verify()
        expect(code).toBe(1)
        expect(output).toContain('http://localhost:9999/og-image.png must use https')
        expect(output).toContain(`no <meta property="og:image" content="${site}/og-image.png" />`)
    })

    it('fails on a placeholder domain written with a trailing dot', async () => {
        spaFallback = false
        await deploy((html) =>
            html.replaceAll(`href="${app}/login"`, 'href="https://app.example.com./login"'),
        )
        const { code, output } = await verify()
        expect(code).toBe(1)
        expect(output).toContain(
            'https://app.example.com./login is a placeholder domain (RFC 2606)',
        )
    })

    it('fails when an unknown path is the home page with 200', async () => {
        spaFallback = true
        await deploy()
        const { code, output } = await verify()
        expect(code).toBe(1)
        expect(output).toContain('an unknown path answered 200, expected 404')
    })
})
