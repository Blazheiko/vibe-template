import { en } from './content/en'
import { pl } from './content/pl'
import type { LandingContent, Locale } from './content/types'
import { uk } from './content/uk'

export * from './routes'

export const CONTENT: Readonly<Record<Locale, LandingContent>> = { en, uk, pl }

export const REPOSITORY_URL = 'https://github.com/Blazheiko/vibe-template'
const DOCS_ROOT = 'https://blazheiko.github.io/vibe-template/'

/** The documentation is Ukrainian at its root and English under /en/; there is no Polish one. */
export const docsUrl = (locale: Locale): string => (locale === 'uk' ? DOCS_ROOT : `${DOCS_ROOT}en/`)
