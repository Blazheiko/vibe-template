/**
 * feat-211: a path the way Vue Router compares it. The router matches a route whatever the
 * case and with a trailing slash, and it decodes percent-encoded characters, so
 * `/Reset-Password`, `/reset-password/` and `/reset-password` are one page. Code that asks
 * "which page is this" by comparing the path with a list must compare this form: compared by
 * the exact spelling, a mailed link opened as `/Reset-Password` kept its token in the address
 * and was sent to the sign-in page as a private one.
 */
export const normalizeRoutePath = (pathname: string): string => {
    let decoded = pathname
    try {
        decoded = decodeURIComponent(pathname)
    } catch {
        // Not valid percent-encoding: compared as it is.
    }
    const trimmed = decoded.toLowerCase().replace(/\/+$/, '')
    return trimmed === '' ? '/' : trimmed
}
