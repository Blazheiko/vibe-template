// HTTP paths and WS request events both live under the backend's API_PATH_PREFIX
// (code-issues items 17 and 73). vite.config.ts compiles that prefix in as VITE_API_PATH_PREFIX,
// taken from API_PATH_PREFIX in packages/backend/.env or the shell (feat-192).
import { normalizeApiPrefix } from 'shared/api-prefix'

export { normalizeApiPrefix }

export const API_PREFIX = normalizeApiPrefix(import.meta.env.VITE_API_PATH_PREFIX)

/** `/<API_PREFIX>/<route>`: an HTTP path relative to BASE_URL. */
export const apiPath = (route: string, prefix: string = API_PREFIX): string =>
    `/${prefix}/${route.replace(/^\/+/, '')}`
