// feat-205 (security review 2026-11-12, L-17): the one-time token of a mailed link (password
// reset, e-mail verification, OAuth link) arrives in the query of the address. Everything that
// reads the address then carries it: Sentry Session Replay records the page URL in events the
// SDK does not let the application rewrite, the URL goes into navigation spans, breadcrumbs
// and the Referer header.
//
// So the token is taken out of the address before anything can read it: once at start-up,
// before Sentry is initialised (strip-url-token.ts), and in a router guard for a navigation
// inside the application. The page that needs it reads it from here.
//
// It is kept in sessionStorage, not only in memory: a reload of the page must not turn a valid
// link into "invalid link". It lives until the page has used it (clearUrlToken) or the tab
// closes. A browser without sessionStorage keeps it in memory for the life of the page.

/** The pages a mailed link opens, by the path of their route. */
export const TOKEN_ROUTE_PATHS = [
    '/reset-password',
    '/verify-email',
    '/oauth/link/confirm',
] as const

const QUERY_PARAM = 'token'
const STORAGE_PREFIX = 'one-time-url-token:'
const memory = new Map<string, string>()

const routePathOf = (pathname: string): string | undefined =>
    // The application may be served under a base path: the route path is the end of it.
    TOKEN_ROUTE_PATHS.find((path) => pathname === path || pathname.endsWith(path))

const store = (path: string, token: string): void => {
    memory.set(path, token)
    try {
        window.sessionStorage.setItem(STORAGE_PREFIX + path, token)
    } catch {
        // Private mode or blocked storage: the copy in memory serves this page load.
    }
}

/** True for a path whose `?token=` is taken out of the address. */
export const isTokenRoute = (path: string): boolean => routePathOf(path) !== undefined

/** Keeps the token of a mailed link for the page at `path`. An empty token keeps nothing. */
export const stashUrlToken = (path: string, token: string): void => {
    const routePath = routePathOf(path)
    const trimmed = token.trim()
    if (routePath === undefined || trimmed === '') return
    store(routePath, trimmed)
}

/** The token kept for the page at `path`, or an empty string. */
export const readUrlToken = (path: string): string => {
    const routePath = routePathOf(path)
    if (routePath === undefined) return ''
    const inMemory = memory.get(routePath)
    if (inMemory !== undefined) return inMemory
    try {
        return window.sessionStorage.getItem(STORAGE_PREFIX + routePath) ?? ''
    } catch {
        return ''
    }
}

/** Forgets the token of the page at `path`: it was used, or the server refused it for good. */
export const clearUrlToken = (path: string): void => {
    const routePath = routePathOf(path)
    if (routePath === undefined) return
    memory.delete(routePath)
    try {
        window.sessionStorage.removeItem(STORAGE_PREFIX + routePath)
    } catch {
        // Nothing was stored there.
    }
}

/**
 * Takes `?token=` of a mailed link out of the address the browser shows, keeping it for the
 * page. Synchronous, with `history.replaceState`: nothing is navigated, and whatever reads
 * `location.href` afterwards sees the address without the token. True when it was there.
 */
export const stripUrlTokenFromLocation = (win: Window = window): boolean => {
    const { pathname, search, hash } = win.location
    if (routePathOf(pathname) === undefined) return false
    const params = new URLSearchParams(search)
    const token = params.get(QUERY_PARAM)
    if (token === null) return false
    stashUrlToken(pathname, token)
    params.delete(QUERY_PARAM)
    const query = params.toString()
    win.history.replaceState(
        win.history.state,
        '',
        pathname + (query === '' ? '' : `?${query}`) + hash,
    )
    return true
}

/** What the guard needs of the route a navigation goes to. */
interface TokenRouteTarget {
    path: string
    query: Record<string, unknown>
    hash: string
}

/**
 * The router guard for a navigation inside the application: a navigation to a page of a
 * mailed link with `?token=` keeps the token for the page and goes on to the same address
 * without it, replacing the history entry. Any other navigation goes on as it is (`true`).
 */
export const redirectWithoutUrlToken = (
    to: TokenRouteTarget,
): true | { path: string; query: Record<string, unknown>; hash: string; replace: true } => {
    const token = to.query[QUERY_PARAM]
    if (!isTokenRoute(to.path) || typeof token !== 'string') return true
    stashUrlToken(to.path, token)
    const query = Object.fromEntries(
        Object.entries(to.query).filter(([name]) => name !== QUERY_PARAM),
    )
    return { path: to.path, query, hash: to.hash, replace: true }
}

/** Test hook: the copy in memory is module state. */
export const __resetUrlTokensForTests = (): void => {
    memory.clear()
}
