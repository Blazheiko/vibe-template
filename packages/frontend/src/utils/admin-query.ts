export type AdminQueryValue = string | number | undefined

/**
 * The query string of an admin list request: `?a=1&b=x`, or `''` when nothing is left. A value
 * that is undefined or an empty string is left out (a number, zero included, is not), the keys
 * keep the order they are given in, and the values are encoded.
 */
export function adminQueryString(params: Record<string, AdminQueryValue>): string {
    const query = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === '') continue
        query.set(key, String(value))
    }
    const qs = query.toString()
    return qs === '' ? '' : `?${qs}`
}
