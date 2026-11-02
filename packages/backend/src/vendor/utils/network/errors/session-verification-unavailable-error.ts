import { HttpError } from './http-error.js'

/**
 * The check that a session was not revoked (users.sessionToken, ADR 0002) could not
 * be made, e.g. the database is down. The request is not served on the strength of
 * the Redis record alone: it is answered as 503 without the driver's text.
 */
export class SessionVerificationUnavailableError extends HttpError {
    readonly name = 'SessionVerificationUnavailableError'
    readonly code = 'service_unavailable'
    readonly statusCode = 503

    constructor(message = 'Session verification unavailable', options?: { cause?: unknown }) {
        super(message, options)
    }

    // Fail-closed: no access without the check. No driver text in the body; unlike a
    // Redis outage this one reaches Sentry.
    override get publicMessage(): string {
        return 'Service temporarily unavailable. Try again later.'
    }

    override headers(): Readonly<Record<string, string>> {
        return { 'Retry-After': '1' }
    }

    override readonly logMessage = 'Request failed: session verification unavailable'
}
