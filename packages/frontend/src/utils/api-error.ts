import type { ErrorCode } from 'shared/errors'

/**
 * Client-side outcomes of CSRF recovery. They never come from the backend, so they
 * live next to the shared ErrorCode instead of extending it.
 * - `account_changed`: the session now belongs to another user (another tab logged
 *   in); the action was dropped and the page reloads.
 * - `session_unverified`: the session could not be checked (network, 5xx); the
 *   action was not sent.
 * - `session_renewed` (feat-233): the request went out from a session that a renewal (password
 *   change, "end all other sessions") replaced meanwhile; the user is still signed in and the
 *   action can be tried again.
 */
export type CsrfClientCode = 'account_changed' | 'session_unverified' | 'session_renewed'

/**
 * `code` is what the server answered; it is absent when the request was not sent at
 * all (a local rejection), and then `transportCode` is 0 as for a network error.
 */
export interface HttpApiError {
    message: string
    code?: ErrorCode
    clientCode?: CsrfClientCode
    transportCode: number
}

export interface ApiResponse<T> {
    data: T | null
    error: HttpApiError | null
}
