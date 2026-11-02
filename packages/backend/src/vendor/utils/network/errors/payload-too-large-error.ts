import type { PayloadTooLargeErrorDetails } from 'shared/errors'
import { HttpError } from './http-error.js'

export class PayloadTooLargeError extends HttpError {
    readonly name = 'PayloadTooLargeError'
    readonly code = 'payload_too_large'
    readonly statusCode = 413

    constructor(
        public readonly limit: number,
        public readonly contentType: string,
    ) {
        super(`Payload exceeds limit ${String(limit)} bytes for ${contentType}`)
    }

    override get publicMessage(): string {
        return 'Payload too large'
    }

    override details(): PayloadTooLargeErrorDetails {
        return { kind: 'payload_too_large', limit: this.limit, contentType: this.contentType }
    }

    override logFields(): Record<string, unknown> {
        return { limit: this.limit, contentType: this.contentType }
    }

    override readonly logMessage = 'Payload too large'
}
