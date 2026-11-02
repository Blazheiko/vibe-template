import type { UnsupportedMediaTypeErrorDetails } from 'shared/errors'
import type { BodyKind } from '../http-request-handlers.js'
import { HttpError } from './http-error.js'

export class UnsupportedMediaTypeError extends HttpError {
    readonly name = 'UnsupportedMediaTypeError'
    readonly code = 'unsupported_media_type'
    readonly statusCode = 415

    constructor(
        // null: the request has a body but no Content-Type header.
        public readonly receivedContentType: string | null,
        public readonly allowedKinds: BodyKind[],
    ) {
        super(
            receivedContentType === null
                ? `Missing Content-Type. Allowed: ${allowedKinds.join(', ')}`
                : `Unsupported Content-Type "${receivedContentType}". Allowed: ${allowedKinds.join(', ')}`,
        )
    }

    override get publicMessage(): string {
        return 'Unsupported Media Type'
    }

    override details(): UnsupportedMediaTypeErrorDetails {
        return {
            kind: 'unsupported_media_type',
            receivedContentType: this.receivedContentType,
            allowedKinds: this.allowedKinds,
        }
    }

    override logFields(): Record<string, unknown> {
        return { receivedContentType: this.receivedContentType, allowedKinds: this.allowedKinds }
    }

    override readonly logMessage = 'Unsupported media type'
}
