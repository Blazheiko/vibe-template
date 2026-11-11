/**
 * What the service worker does with a request. Kept free of service worker globals
 * so it can be unit-tested.
 * - `bypass`: no respondWith, the browser goes to the network itself.
 * - `cache-first`: static files that keep their URL per build.
 * - `network-first`: the HTML shell, with the cached copy as the offline fallback.
 * - `stale-while-revalidate`: other same-origin GETs.
 */
export type RequestStrategy = 'bypass' | 'cache-first' | 'network-first' | 'stale-while-revalidate'

export interface RequestDescription {
    url: string
    method: string
    destination: string
    mode: string
    /** Origin the service worker is registered on. */
    swOrigin: string
    /** API_PATH_PREFIX without slashes, e.g. `api` or `v2/backend`. */
    apiPrefix: string
}

const STATIC_PREFIXES = ['/assets/', '/icons/', '/screenshots/', '/splash/', '/audio/']
const STATIC_FILES = new Set(['/manifest.json', '/favicon.svg'])
const NETWORK_ONLY_DESTINATIONS = new Set(['script', 'style', 'worker', 'sharedworker'])

export const isApiPath = (pathname: string, apiPrefix: string): boolean => {
    const root = `/${apiPrefix}`
    return pathname === root || pathname.startsWith(`${root}/`)
}

export const isStaticAssetPath = (pathname: string): boolean =>
    STATIC_PREFIXES.some((prefix) => pathname.startsWith(prefix)) ||
    STATIC_FILES.has(pathname) ||
    pathname.endsWith('.css')

export const classifyRequest = (request: RequestDescription): RequestStrategy => {
    let url: URL
    try {
        url = new URL(request.url)
    } catch {
        return 'bypass'
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'bypass'
    // Mutations, other origins and the API never touch the cache.
    if (request.method.toUpperCase() !== 'GET') return 'bypass'
    if (url.origin !== request.swOrigin) return 'bypass'
    if (isApiPath(url.pathname, request.apiPrefix)) return 'bypass'

    if (isStaticAssetPath(url.pathname)) return 'cache-first'
    if (NETWORK_ONLY_DESTINATIONS.has(request.destination)) return 'bypass'
    if (request.mode === 'navigate' || request.destination === 'document') return 'network-first'
    return 'stale-while-revalidate'
}

/** The cache key of the HTML shell for a navigation: the URL without its query and hash. */
export const navigationCacheKey = (url: string): string => {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname}`
}

/** Only complete same-origin responses the server allows to be stored. */
export const isCacheableResponse = (response: Response): boolean => {
    if (!response.ok || response.type !== 'basic') return false
    const cacheControl = response.headers.get('Cache-Control') ?? ''
    return !/\b(no-store|private)\b/i.test(cacheControl)
}

/** Drops API responses an older service worker may have left in `cacheName`. */
export const removeCachedApiResponses = async (
    storage: CacheStorage,
    cacheName: string,
    apiPrefix: string,
): Promise<number> => {
    const cache = await storage.open(cacheName)
    const stale = (await cache.keys()).filter((request) =>
        isApiPath(new URL(request.url).pathname, apiPrefix),
    )
    await Promise.all(stale.map((request) => cache.delete(request)))
    return stale.length
}
