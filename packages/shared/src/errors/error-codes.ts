// No runtime ArkType here: the frontend imports `ErrorCode`, and any @arktype/type
// import pulls the whole engine into its bundle. The schema lives in
// responses/error-code-schema.ts.
export const ErrorCode = {
    BadRequest: 'bad_request',
    Unauthorized: 'unauthorized',
    Forbidden: 'forbidden',
    NotFound: 'not_found',
    Conflict: 'conflict',
    ValidationFailed: 'validation_failed',
    PayloadTooLarge: 'payload_too_large',
    UnsupportedMediaType: 'unsupported_media_type',
    RateLimited: 'rate_limited',
    CsrfInvalid: 'csrf_invalid',
    InternalError: 'internal_error',
    ServiceUnavailable: 'service_unavailable',
    // An external provider (LLM) failed or did not answer in time.
    UpstreamError: 'upstream_error',
    UpstreamTimeout: 'upstream_timeout',
} as const

export const ErrorCodeValues: readonly ErrorCode[] = Object.values(ErrorCode)

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode]

export interface ValidationIssue {
    /** Dot-separated field path (`nested.name`); `''` for the whole payload. */
    path: string
    message: string
}

export interface ValidationErrorDetails {
    kind: 'validation'
    /** One human-readable line per problem. */
    messages: string[]
    /** The same problems mapped to field paths. */
    issues?: ValidationIssue[]
    fields?: string[]
}

export interface ParameterValidationErrorDetails {
    kind: 'parameter_validation'
    parameter: string
    messages?: string[]
}

export interface PayloadTooLargeErrorDetails {
    kind: 'payload_too_large'
    limit: number
    contentType?: string
}

export interface UnsupportedMediaTypeErrorDetails {
    kind: 'unsupported_media_type'
    receivedContentType?: string
    allowedKinds: string[]
}

export interface RateLimitedErrorDetails {
    kind: 'rate_limited'
    retryAfterMs?: number
}

export type ErrorDetails =
    | ValidationErrorDetails
    | ParameterValidationErrorDetails
    | PayloadTooLargeErrorDetails
    | UnsupportedMediaTypeErrorDetails
    | RateLimitedErrorDetails
