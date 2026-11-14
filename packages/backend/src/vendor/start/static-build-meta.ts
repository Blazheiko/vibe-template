import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * The file the frontend build writes next to index.html (packages/frontend/vite.build-meta.ts).
 * It says under which API prefix the SPA was built: the prefix is compiled into the bundle
 * (VITE_API_PATH_PREFIX), while the server reads its own at run time (API_PATH_PREFIX).
 */
export const BUILD_META_FILE = 'build-meta.json'

export type StaticBuildCheck =
    | { kind: 'match'; prefix: string }
    | { kind: 'mismatch'; builtFor: string; served: string }
    /** No file, or not one this check can read: static files of another origin. */
    | { kind: 'unknown' }

const builtPrefixOf = (text: string): string | null => {
    try {
        const meta: unknown = JSON.parse(text)
        const prefix = (meta as { apiPathPrefix?: unknown } | null)?.apiPathPrefix
        return typeof prefix === 'string' && prefix !== '' ? prefix : null
    } catch {
        return null
    }
}

/**
 * feat-153 (review 2026-11-10, M6): an image built for `/api` and started with
 * API_PATH_PREFIX=v1 serves a SPA whose calls never reach the API (a GET gets index.html, anything
 * else 404), with nothing in the log to say why. Compares the prefix the SPA was built for with the one the server serves.
 */
export const checkStaticBuildPrefix = async (
    staticPath: string,
    servedPrefix: string,
): Promise<StaticBuildCheck> => {
    const text = await fs.readFile(path.join(staticPath, BUILD_META_FILE), 'utf8').catch(() => null)
    if (text === null) return { kind: 'unknown' }
    const builtFor = builtPrefixOf(text)
    if (builtFor === null) return { kind: 'unknown' }
    return builtFor === servedPrefix
        ? { kind: 'match', prefix: builtFor }
        : { kind: 'mismatch', builtFor, served: servedPrefix }
}
