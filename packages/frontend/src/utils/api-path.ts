// HTTP paths and WS request events both live under the backend's API_PATH_PREFIX
// (code-issues items 17 and 73). Set VITE_API_PATH_PREFIX when the backend runs with a
// non-default API_PATH_PREFIX.
import { normalizeApiPrefix } from 'shared/ws-client'

export { normalizeApiPrefix }

export const API_PREFIX = normalizeApiPrefix(import.meta.env.VITE_API_PATH_PREFIX)

/** `/<API_PREFIX>/<route>`: an HTTP path relative to BASE_URL. */
export const apiPath = (route: string, prefix: string = API_PREFIX): string =>
    `/${prefix}/${route.replace(/^\/+/, '')}`
