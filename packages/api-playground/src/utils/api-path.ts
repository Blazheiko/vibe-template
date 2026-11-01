// The playground talks to a backend whose routes live under API_PATH_PREFIX.
// VITE_API_PATH_PREFIX mirrors it (default "api"), so the route list, the health
// check and the dev proxy no longer assume /api (code-issues item 62).
import { normalizeApiPrefix } from 'shared/ws-client'

export { normalizeApiPrefix }

export const API_PATH_PREFIX = normalizeApiPrefix(import.meta.env.VITE_API_PATH_PREFIX)

/** `<baseUrl>/<prefix>/<path>`; an empty baseUrl gives a same-origin path (dev proxy). */
export const apiUrl = (baseUrl: string, path: string, prefix: string = API_PATH_PREFIX): string =>
    `${baseUrl.trim().replace(/\/+$/, '')}/${prefix}/${path.replace(/^\/+/, '')}`

/** http → ws, https → wss (code-issues item 63: https used to become ws://). */
export const toWsUrl = (httpUrl: string): string =>
    httpUrl
        .trim()
        .replace(/^https:\/\//i, 'wss://')
        .replace(/^http:\/\//i, 'ws://')
