/**
 * The landing's address contract (docs/plan/landing-plan.md, "Контракт URL").
 *
 * - LANDING_APP_URL: where the Log in / Sign up buttons lead. Default: FRONTEND_URL of
 *   packages/backend/.env, else http://localhost:5173 (the SPA dev server).
 * - LANDING_SITE_URL: the landing's own public address (canonical, hreflang, og:url, sitemap).
 *   Default: LANDING_URL of packages/backend/.env, else http://localhost:5175.
 * - LANDING_STRICT: only an explicit `true` turns the production checks on. It does not follow the
 *   Vite mode: `vite build` runs in `production` by default, so every local build would be strict.
 *
 * Both addresses are origins without a trailing slash. PRODUCT.siteUrl is the app's address and is
 * not read here.
 */

export interface LandingUrls {
    /** Origin of the application, e.g. https://app.example.com. */
    readonly appUrl: string
    /** Origin of the landing itself, e.g. https://example.com. */
    readonly siteUrl: string
    readonly strict: boolean
}

type Env = Readonly<Record<string, string | undefined>>

export const DEFAULT_APP_URL = 'http://localhost:5173'
export const DEFAULT_SITE_URL = 'http://localhost:5175'

const nonEmpty = (value: string | undefined): string | undefined =>
    value === undefined || value.trim() === '' ? undefined : value.trim()

/** An http(s) origin from `value`; a path other than `/`, a query or a fragment is refused. */
export function normalizeOrigin(value: string, name: string): string {
    let url: URL
    try {
        url = new URL(value)
    } catch {
        throw new Error(`${name}: "${value}" is not an absolute URL`)
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error(`${name}: "${value}" must use http or https`)
    }
    if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
        throw new Error(`${name}: "${value}" must be an origin, without a path, query or fragment`)
    }
    if (url.username !== '' || url.password !== '') {
        throw new Error(`${name}: "${value}" must not carry credentials`)
    }
    return url.origin
}

export function parseStrict(value: string | undefined): boolean {
    const raw = nonEmpty(value)
    if (raw === undefined || raw === 'false') return false
    if (raw === 'true') return true
    throw new Error(`LANDING_STRICT: "${raw}" must be true or false`)
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0'])
// Reserved for documentation (RFC 2606): the placeholders of .env.example and the docs.
const PLACEHOLDER_DOMAINS = ['example', 'example.com', 'example.net', 'example.org']

/** Why `url` cannot be a production address, or null. Shared with build/verify-dist.ts. */
export function productionProblem(url: string): string | null {
    let parsed: URL
    try {
        parsed = new URL(url)
    } catch {
        return 'is not an absolute URL'
    }
    if (parsed.protocol !== 'https:') return 'must use https'
    const host = parsed.hostname.toLowerCase()
    if (LOCAL_HOSTS.has(host) || host.endsWith('.localhost')) return 'points to the local machine'
    if (PLACEHOLDER_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`))) {
        return 'is a placeholder domain (RFC 2606)'
    }
    return null
}

/**
 * Resolves the two addresses from the shell (`env`) and packages/backend/.env (`backendEnv`).
 * Throws with the variable name on an invalid value, on equal origins, and in strict mode on an
 * address that is not a production one.
 */
/** The value of the first source that has one, and where it came from. */
function pick(
    candidates: readonly (readonly [string | undefined, string])[],
): readonly [string, string] {
    for (const [value, source] of candidates) {
        const present = nonEmpty(value)
        if (present !== undefined) return [present, source]
    }
    throw new Error('unreachable: the last candidate is a constant')
}

/**
 * Resolves the two addresses from the shell (`env`) and packages/backend/.env (`backendEnv`).
 * Throws with the variable name on an invalid value, on equal origins, and in strict mode on an
 * address that is not a production one.
 */
export function resolveLandingUrls(env: Env, backendEnv: Env = {}): LandingUrls {
    const [appValue, appSource] = pick([
        [env.LANDING_APP_URL, 'LANDING_APP_URL'],
        [backendEnv.FRONTEND_URL, 'FRONTEND_URL in packages/backend/.env'],
        [DEFAULT_APP_URL, 'the default'],
    ])
    const [siteValue, siteSource] = pick([
        [env.LANDING_SITE_URL, 'LANDING_SITE_URL'],
        [backendEnv.LANDING_URL, 'LANDING_URL in packages/backend/.env'],
        [DEFAULT_SITE_URL, 'the default'],
    ])
    const appUrl = normalizeOrigin(appValue, appSource)
    const siteUrl = normalizeOrigin(siteValue, siteSource)
    const strict = parseStrict(env.LANDING_STRICT)

    // One origin for both is not supported: the backend answers every unknown path with the SPA,
    // and the service worker of the SPA controls `/` (docs/plan/landing-plan.md).
    if (appUrl === siteUrl) {
        throw new Error(
            `The landing (${siteSource}) and the application (${appSource}) are the same origin, ${appUrl}: they need different origins. ` +
                `Locally the landing is ${DEFAULT_SITE_URL}: set LANDING_URL=${DEFAULT_SITE_URL} in packages/backend/.env (see .env.example).`,
        )
    }
    if (strict) {
        for (const [name, url] of [
            [appSource, appUrl],
            [siteSource, siteUrl],
        ] as const) {
            const problem = productionProblem(url)
            if (problem !== null) {
                throw new Error(
                    `${name}: "${url}" ${problem} (LANDING_STRICT=true; set LANDING_STRICT=false for a local build)`,
                )
            }
        }
    }
    return { appUrl, siteUrl, strict }
}
