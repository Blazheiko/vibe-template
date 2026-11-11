import type { Plugin } from 'vite'

/**
 * Writes `build-meta.json` next to index.html: the API prefix this bundle was built for.
 *
 * The prefix is compiled in (VITE_API_PATH_PREFIX), while the backend reads its own at run time
 * (API_PATH_PREFIX). When the backend serves this build (SERVE_STATIC), it compares the two at
 * startup and logs a mismatch — otherwise the SPA's calls never reach the API, with nothing to
 * say why (feat-153; packages/backend/src/vendor/start/static-build-meta.ts).
 */
export const buildMeta = (): Plugin => {
    let apiPathPrefix = 'api'
    return {
        name: 'build-meta',
        apply: 'build',
        configResolved(config) {
            // The same normalisation as normalizeApiPrefix in shared/ws-client.
            const raw = (config.env.VITE_API_PATH_PREFIX as string | undefined) ?? ''
            apiPathPrefix = raw.trim().replace(/^\/+|\/+$/g, '') || 'api'
        },
        generateBundle() {
            this.emitFile({
                type: 'asset',
                fileName: 'build-meta.json',
                source: `${JSON.stringify({ apiPathPrefix })}\n`,
            })
        },
    }
}
