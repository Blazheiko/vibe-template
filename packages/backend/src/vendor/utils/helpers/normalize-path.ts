/**
 * A route or URL prefix without its outer slashes: `/api/` -> `api`, `/` -> ``. At most one slash
 * is taken off each end.
 */
export function normalizePath(path: string): string {
    if (path === '') return ''
    let normalizedPath = path
    if (normalizedPath.endsWith('/')) normalizedPath = normalizedPath.slice(0, -1)
    if (normalizedPath.startsWith('/')) normalizedPath = normalizedPath.slice(1)
    return normalizedPath
}
