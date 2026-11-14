// One dictionary per locale. Every locale implements the whole interface, so a missing text is a
// type error, not an empty spot on the page.

export const LOCALES = ['en', 'uk', 'pl'] as const
export type Locale = (typeof LOCALES)[number]

export interface FeatureItem {
    readonly title: string
    readonly text: string
}

export interface LandingContent {
    /** Name of the language in itself, for the switcher. */
    readonly languageName: string
    /** Follows the product name in the page title. */
    readonly tagline: string
    /** Meta description and the hero lead. */
    readonly description: string
    readonly nav: {
        /** Accessible name of the main navigation. */
        readonly label: string
        readonly features: string
        readonly stack: string
        readonly start: string
        readonly docs: string
        readonly language: string
    }
    readonly hero: {
        readonly eyebrow: string
        readonly title: string
        readonly login: string
        readonly register: string
    }
    readonly features: {
        readonly title: string
        readonly lead: string
        readonly items: readonly FeatureItem[]
    }
    readonly stack: {
        readonly title: string
        readonly lead: string
        readonly items: readonly FeatureItem[]
    }
    readonly audience: {
        readonly title: string
        readonly items: readonly string[]
    }
    readonly start: {
        readonly title: string
        readonly lead: string
        readonly steps: readonly FeatureItem[]
        readonly docs: string
        readonly repository: string
    }
    readonly cta: {
        readonly title: string
        readonly text: string
    }
    readonly footer: {
        /** Accessible name of the footer navigation. */
        readonly label: string
        readonly privacy: string
        readonly terms: string
        readonly docs: string
        readonly repository: string
    }
    readonly notFound: {
        readonly title: string
        readonly text: string
        readonly home: string
    }
}
