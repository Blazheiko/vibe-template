import type { BodyKind } from '#vendor/utils/network/http-request-handlers.js'
import { HttpError } from './http-error.js'

/** Body kinds the server actually parses and can therefore reject as malformed. */
export type MalformedBodyKind = Extract<BodyKind, 'json'>

// A request body that cannot be parsed. The message never includes the body or
// the parser's message: JSON.parse quotes the input ("<body>" is not valid JSON),
// and bodies carry passwords and tokens.
export class MalformedBodyError extends HttpError {
    readonly name = 'MalformedBodyError'
    readonly code = 'bad_request'
    readonly statusCode = 400

    constructor(public readonly bodyKind: MalformedBodyKind) {
        super(`Malformed ${bodyKind} body`)
    }

    // A client error: no body and no parser text in the log, kept out of Sentry (warn).
    override logFields(): Record<string, unknown> {
        return { bodyKind: this.bodyKind }
    }

    override readonly logMessage = 'Malformed request body'
}
