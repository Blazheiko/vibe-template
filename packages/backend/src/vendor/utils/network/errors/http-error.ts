import type { ErrorCode, ErrorDetails } from 'shared/errors'

/**
 * A thrown error that knows its answer: status, code, client text, details and
 * how to log it. classifyError turns it into a response for HTTP and WS alike;
 * a new error type needs no change in server.ts or the WS dispatcher.
 */
export abstract class HttpError extends Error {
    abstract readonly statusCode: number
    abstract readonly code: ErrorCode

    /** Text for the client. `message` stays for the log and may carry more. */
    get publicMessage(): string {
        return this.message
    }

    details(): ErrorDetails | undefined {
        return undefined
    }

    /** HTTP-only response headers (Retry-After); WS has no headers. */
    headers(): Readonly<Record<string, string>> {
        return {}
    }

    /** HTTP only: close the connection with the answer (the rest of a body is not read). */
    closeConnection(): boolean {
        return false
    }

    /** Log level; by default 4xx are logged at warn, 5xx at error. */
    logLevel(): 'warn' | 'error' {
        return this.statusCode >= 500 ? 'error' : 'warn'
    }

    /** Log record fields. Default: the error itself; override to keep payloads out. */
    logFields(): Record<string, unknown> {
        return { err: this }
    }

    /** Log message. */
    readonly logMessage: string = 'Handle Error'
}
