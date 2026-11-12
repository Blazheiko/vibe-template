// The product's own name and texts: the one place to edit when the template becomes your app.
// The frontend reads it in components and locales, and the Vite plugin `vite.product.ts` fills
// index.html and generates manifest.json and robots.txt from it; the backend puts it into the
// emails and the AI support prompts. Not APP_NAME: that variable is the process title in logs.
// A module of its own with no dependencies, so the browser bundle and the Vite config can import it.
//
// Images are files, not text, and are replaced by hand: public/icons/, public/splash/,
// public/favicon.svg and src/assets/logo.svg in packages/frontend.

export interface ProductInfo {
    /** Full name: page title, PWA name, email header and texts, AI support prompts. */
    readonly name: string
    /** Up to 12 characters: the PWA name under the home-screen icon. */
    readonly shortName: string
    /** The word the sign-in page types out as its logo. */
    readonly logoText: string
    /** Follows the name in the page title: `<name> — <tagline>`. */
    readonly tagline: string
    /** One sentence for the meta description, social cards, the manifest and the install prompt. */
    readonly description: string
    /** Public address of the site with a trailing slash: canonical link, social cards, sitemap. */
    readonly siteUrl: string
    /** Address the AI support agent sends users to when it has no answer. */
    readonly supportEmail: string
}

export const PRODUCT: ProductInfo = Object.freeze({
    name: 'Vibe Template',
    shortName: 'Vibe',
    logoText: 'VIBE',
    tagline: 'Educational Vue 3 and TypeScript Template',
    description:
        'An educational Vue 3 and TypeScript project template with frontend, backend, shared packages, tests, and build tooling.',
    siteUrl: 'https://vibe-template.example/',
    supportEmail: 'support@vibe-template.example',
})
