// The one rule for API_PATH_PREFIX (feat-193): the backend config, the frontend and playground
// bundles, shared/dev-backend and the build-meta plugin all read the prefix through it, so the
// server and the client cannot disagree on a value such as `/`. A module of its own with no
// dependencies: the browser bundles, the backend and the Vite configs import it.

/** The prefix when API_PATH_PREFIX is unset or holds nothing but slashes and spaces. */
export const DEFAULT_API_PREFIX = 'api'

/**
 * The prefix HTTP paths and WS request events live under: spaces and every outer slash trimmed
 * (`/v1/` → `v1`), `api` when nothing is left (``, `/`, `//`). There is no root-level API.
 */
export const normalizeApiPrefix = (raw: string | undefined): string => {
    const trimmed = (raw ?? '').trim().replace(/^\/+|\/+$/g, '')
    return trimmed === '' ? DEFAULT_API_PREFIX : trimmed
}
