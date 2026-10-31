/**
 * The check that a session was not revoked (users.sessionToken, ADR 0002) could not
 * be made, e.g. the database is down. The request is not served on the strength of
 * the Redis record alone: it is answered as 503 without the driver's text.
 */
export class SessionVerificationUnavailableError extends Error {
    readonly name = 'SessionVerificationUnavailableError'
    readonly code = 'service_unavailable'
    readonly statusCode = 503

    constructor(message = 'Session verification unavailable', options?: { cause?: unknown }) {
        super(message, options)
    }
}
