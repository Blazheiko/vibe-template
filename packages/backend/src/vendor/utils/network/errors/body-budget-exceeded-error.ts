import { HttpError } from './http-error.js'

/**
 * The process is buffering as many bytes of request bodies as it allows (feat-201): in total
 * (503) or from this client address (429). The connection is closed with the answer, so the
 * rest of the body is not read.
 */
export class BodyBudgetExceededError extends HttpError {
    readonly name = 'BodyBudgetExceededError'
    readonly code: 'rate_limited' | 'service_unavailable'
    readonly statusCode: 429 | 503

    constructor(public readonly scope: 'ip' | 'global') {
        super(`Request bodies in flight over the ${scope} limit`)
        this.code = scope === 'ip' ? 'rate_limited' : 'service_unavailable'
        this.statusCode = scope === 'ip' ? 429 : 503
    }

    override get publicMessage(): string {
        return this.scope === 'ip'
            ? 'Too many uploads in progress. Try again later.'
            : 'Service temporarily unavailable. Try again later.'
    }

    override headers(): Readonly<Record<string, string>> {
        return { 'Retry-After': '1' }
    }

    override closeConnection(): boolean {
        return true
    }

    override logFields(): Record<string, unknown> {
        return { scope: this.scope }
    }

    // A full budget is load or an attack, not a fault of the server: warn for both scopes.
    override logLevel(): 'warn' | 'error' {
        return 'warn'
    }

    override readonly logMessage = 'Request bodies in flight over the limit'
}
