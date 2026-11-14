import type { Plugin } from 'vite'
// The source, not the `shared/product` package: a Vite config is loaded before Vite applies the
// `shared-source` condition, so the package name would resolve to shared/dist and keep the values
// of the last `shared` build. A relative import is bundled into the config, and Vite restarts the
// dev server when the file changes, so index.html, manifest.json and robots.txt follow an edit
// without rebuilding `shared` (feat-193). ESLint forbids `shared/*` in Vite configs.
import { PRODUCT, type ProductInfo } from '../shared/src/product/index'

/**
 * Puts the product name and texts from `shared/product` into the files a browser reads before any
 * script runs: index.html (`%PRODUCT_*%` placeholders), manifest.json and robots.txt. The dev
 * server answers the last two from memory, `vite build` writes them next to index.html. Renaming
 * the app is then one edit in packages/shared/src/product/index.ts (feat-191).
 */

const escapeHtml = (value: string): string =>
    value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')

// JSON inside <script>: `<` as <, so no value can close the element.
const scriptJson = (value: unknown): string =>
    JSON.stringify(value, null, 4).replace(/</g, '\\u003c')

const jsonLd = (product: ProductInfo) => ({
    '@context': 'https://schema.org',
    '@type': 'WebApplication',
    name: product.name,
    url: product.siteUrl,
    description: product.description,
    applicationCategory: 'BusinessApplication',
    operatingSystem: 'Web',
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    featureList: [
        'Vue 3 frontend workspace',
        'TypeScript backend workspace',
        'Shared schema and utility package',
        'Pnpm workspace configuration',
        'Typecheck, lint, test, and build scripts',
    ],
})

/** Fills the `%PRODUCT_*%` placeholders of index.html; an unknown one fails the build. */
export function renderProductHtml(html: string, product: ProductInfo = PRODUCT): string {
    const values = new Map([
        ['PRODUCT_NAME', escapeHtml(product.name)],
        ['PRODUCT_TITLE', escapeHtml(`${product.name} — ${product.tagline}`)],
        ['PRODUCT_DESCRIPTION', escapeHtml(product.description)],
        ['PRODUCT_SITE_URL', escapeHtml(product.siteUrl)],
        ['PRODUCT_JSON_LD', scriptJson(jsonLd(product))],
    ])
    return html.replace(/%(PRODUCT_[A-Z_]+)%/g, (placeholder, key: string) => {
        const value = values.get(key)
        if (value === undefined) throw new Error(`index.html: unknown placeholder ${placeholder}`)
        return value
    })
}

export function productManifest(product: ProductInfo = PRODUCT): string {
    const manifest = {
        name: product.name,
        short_name: product.shortName,
        id: '',
        start_url: '/',
        scope: '/',
        dir: 'ltr',
        display: 'standalone',
        launch_handler: { client_mode: 'navigate-existing' },
        prefer_related_applications: false,
        related_applications: [{ platform: 'webapp', url: '/manifest.json', id: '' }],
        background_color: '#EDF1F7',
        theme_color: '#4E7FA8',
        description: product.description,
        categories: ['education', 'developer', 'productivity'],
        icons: [
            ...[192, 512].map((size) => ({
                src: `/icons/icon_${size}x${size}.png`,
                type: 'image/png',
                sizes: `${size}x${size}`,
                purpose: 'any',
            })),
            ...[192, 512].map((size) => ({
                src: `/icons/icon_maskable_${size}x${size}.png`,
                type: 'image/png',
                sizes: `${size}x${size}`,
                purpose: 'maskable',
            })),
        ],
        screenshots: [
            {
                src: '/screenshots/editor-mobile.png',
                type: 'image/png',
                sizes: '720x1480',
                form_factor: 'narrow',
                label: 'Educational application template UI',
            },
            {
                src: '/screenshots/templates-mobile.png',
                type: 'image/png',
                sizes: '720x1480',
                form_factor: 'narrow',
                label: 'Full-stack workspace template structure',
            },
        ],
    }
    return `${JSON.stringify(manifest, null, 4)}\n`
}

export function productRobots(product: ProductInfo = PRODUCT): string {
    return `User-agent: *\nAllow: /\n\nSitemap: ${new URL('sitemap.xml', product.siteUrl).href}\n`
}

const GENERATED = new Map([
    ['manifest.json', { type: 'application/manifest+json', body: () => productManifest() }],
    ['robots.txt', { type: 'text/plain; charset=utf-8', body: () => productRobots() }],
])

/** Files the plugin writes next to index.html instead of a copy from public/. */
export const GENERATED_PUBLIC_FILES: readonly string[] = [...GENERATED.keys()]

export const productBranding = (): Plugin => ({
    name: 'product-branding',
    transformIndexHtml: {
        order: 'pre',
        handler: (html) => renderProductHtml(html),
    },
    configureServer(server) {
        server.middlewares.use((req, res, next) => {
            const path = new URL(req.url ?? '/', 'http://localhost').pathname
            const file = GENERATED.get(path.slice(1))
            if (!file) {
                next()
                return
            }
            res.setHeader('Content-Type', file.type)
            res.end(file.body())
        })
    },
    generateBundle() {
        for (const [fileName, file] of GENERATED) {
            this.emitFile({ type: 'asset', fileName, source: file.body() })
        }
    },
})
