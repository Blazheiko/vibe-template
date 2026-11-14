// @vitest-environment node
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { PRODUCT, type ProductInfo } from 'shared/product'

import { productManifest, productRobots, renderProductHtml } from '../../vite.product'

// feat-191: index.html, manifest.json and robots.txt take the product name from shared/product.
const indexHtml = readFileSync(new URL('../../index.html', import.meta.url), 'utf8')

const OTHER: ProductInfo = {
    name: 'Acme <Notes> & "Co"',
    shortName: 'Acme',
    logoText: 'ACME',
    tagline: 'Notes for teams',
    description: 'Shared notes </script> for teams.',
    siteUrl: 'https://notes.acme.test/',
    supportEmail: 'help@acme.test',
}

describe('renderProductHtml', () => {
    it('leaves no placeholder and no name of the template in index.html', () => {
        const html = renderProductHtml(indexHtml, OTHER)
        expect(html).not.toMatch(/%PRODUCT_/)
        expect(html).not.toMatch(/vibe/i)
        expect(html).toContain(
            '<title>Acme &lt;Notes&gt; &amp; &quot;Co&quot; — Notes for teams</title>',
        )
        expect(html).toContain('<link rel="canonical" href="https://notes.acme.test/" />')
    })

    it('writes the JSON-LD as JSON that cannot close its script element', () => {
        const html = renderProductHtml(indexHtml, OTHER)
        const block =
            /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? ''
        expect(block).not.toContain('<')
        expect(JSON.parse(block)).toMatchObject({
            name: OTHER.name,
            url: OTHER.siteUrl,
            description: OTHER.description,
        })
    })

    it('fails on a placeholder it does not know', () => {
        expect(() => renderProductHtml('<p>%PRODUCT_NAMES%</p>')).toThrow('%PRODUCT_NAMES%')
    })

    it('uses shared/product by default', () => {
        expect(renderProductHtml(indexHtml)).toContain(
            `<title>${PRODUCT.name} — ${PRODUCT.tagline}`,
        )
    })
})

describe('generated public files', () => {
    it('manifest.json names the product', () => {
        const manifest: unknown = JSON.parse(productManifest(OTHER))
        expect(manifest).toMatchObject({
            name: OTHER.name,
            short_name: OTHER.shortName,
            description: OTHER.description,
        })
    })

    it('robots.txt points at the sitemap of the site', () => {
        expect(productRobots(OTHER)).toContain('Sitemap: https://notes.acme.test/sitemap.xml\n')
    })

    it('the short name fits under a home-screen icon', () => {
        expect(PRODUCT.shortName.length).toBeLessThanOrEqual(12)
    })
})
