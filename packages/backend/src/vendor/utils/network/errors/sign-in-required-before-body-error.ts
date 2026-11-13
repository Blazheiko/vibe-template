import { HttpError } from './http-error.js'

/**
 * A route that reads its body only for a signed-in user got a request without the cookie of a
 * signed-in session (feat-202). Answered 401 before a byte of the body is read; the
 * connection is closed with the answer, so the upload stops.
 */
export class SignInRequiredBeforeBodyError extends HttpError {
    readonly name = 'SignInRequiredBeforeBodyError'
    readonly code = 'unauthorized'
    readonly statusCode = 401

    constructor() {
        super('Unauthorized')
    }

    override closeConnection(): boolean {
        return true
    }

    // Nothing of the request: an anonymous upload attempt is not worth its headers in the log.
    override logFields(): Record<string, unknown> {
        return {}
    }

    override readonly logMessage = 'Body refused: no signed-in session cookie'
}
