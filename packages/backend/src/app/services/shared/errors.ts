import type { ErrorCode } from 'shared/errors'
import type { Result as ResultType } from 'better-result'

export type AppError =
    | { _tag: 'BadRequest'; message: string; reason?: string }
    | { _tag: 'Unauthorized'; message: string; reason?: string }
    | { _tag: 'Forbidden'; message: string; reason?: string }
    | { _tag: 'NotFound'; resource: string; message: string }
    | { _tag: 'Conflict'; message: string; reason?: string }
    | { _tag: 'RateLimited'; message: string; reason?: string; retryAfterSeconds?: number }
    | { _tag: 'Internal'; publicMessage: string; cause?: unknown }
    // A dependency (Redis) is temporarily down; answered with Retry-After.
    | { _tag: 'ServiceUnavailable'; message: string; retryAfterSeconds: number; cause?: unknown }
    // An external provider (LLM) answered with an error / did not answer in time.
    | { _tag: 'UpstreamError'; message: string; cause?: unknown }
    | { _tag: 'UpstreamTimeout'; message: string; cause?: unknown }

export type AppErrorCode = Extract<
    ErrorCode,
    | 'bad_request'
    | 'unauthorized'
    | 'forbidden'
    | 'not_found'
    | 'conflict'
    | 'rate_limited'
    | 'internal_error'
    | 'service_unavailable'
    | 'upstream_error'
    | 'upstream_timeout'
>

export type AppResult<T> = ResultType<T, AppError>

const APP_ERROR_CODE_MAP: Record<AppError['_tag'], AppErrorCode> = {
    BadRequest: 'bad_request',
    Unauthorized: 'unauthorized',
    Forbidden: 'forbidden',
    NotFound: 'not_found',
    Conflict: 'conflict',
    RateLimited: 'rate_limited',
    Internal: 'internal_error',
    ServiceUnavailable: 'service_unavailable',
    UpstreamError: 'upstream_error',
    UpstreamTimeout: 'upstream_timeout',
}

const APP_ERROR_STATUS_MAP: Record<AppError['_tag'], number> = {
    BadRequest: 400,
    Unauthorized: 401,
    Forbidden: 403,
    NotFound: 404,
    Conflict: 409,
    RateLimited: 429,
    Internal: 500,
    ServiceUnavailable: 503,
    UpstreamError: 502,
    UpstreamTimeout: 504,
}

export function badRequest(message: string, reason?: string): AppError {
    return {
        _tag: 'BadRequest',
        message,
        ...(reason !== undefined ? { reason } : {}),
    }
}

export function unauthorized(message = 'Unauthorized', reason?: string): AppError {
    return {
        _tag: 'Unauthorized',
        message,
        ...(reason !== undefined ? { reason } : {}),
    }
}

export const SESSION_REVOKED = 'session_revoked'

/**
 * The session the request presented is no longer current: its users.session_token was
 * rotated (ADR 0002) after the request was let in, e.g. by a claim or a password change.
 */
export function sessionRevoked(): AppError {
    return unauthorized('Session has been revoked', SESSION_REVOKED)
}

export function forbidden(message: string, reason?: string): AppError {
    return {
        _tag: 'Forbidden',
        message,
        ...(reason !== undefined ? { reason } : {}),
    }
}

export function notFound(resource: string, message: string): AppError {
    return { _tag: 'NotFound', resource, message }
}

export function conflict(message: string, reason?: string): AppError {
    return {
        _tag: 'Conflict',
        message,
        ...(reason !== undefined ? { reason } : {}),
    }
}

export function rateLimited(
    message: string,
    options?: { reason?: string; retryAfterSeconds?: number },
): AppError {
    return {
        _tag: 'RateLimited',
        message,
        ...(options?.reason !== undefined ? { reason: options.reason } : {}),
        ...(options?.retryAfterSeconds !== undefined
            ? { retryAfterSeconds: options.retryAfterSeconds }
            : {}),
    }
}

export function internal(cause: unknown, publicMessage = 'Internal error'): AppError {
    return {
        _tag: 'Internal',
        publicMessage,
        ...(cause !== undefined ? { cause } : {}),
    }
}

export function serviceUnavailable(cause?: unknown): AppError {
    return {
        _tag: 'ServiceUnavailable',
        message: 'Service temporarily unavailable. Try again later.',
        retryAfterSeconds: 1,
        ...(cause !== undefined ? { cause } : {}),
    }
}

// The provider's own error text stays in the log (cause), never in the response.
export function upstreamError(cause?: unknown, message = 'AI provider error'): AppError {
    return { _tag: 'UpstreamError', message, ...(cause !== undefined ? { cause } : {}) }
}

export function upstreamTimeout(
    cause?: unknown,
    message = 'AI provider did not answer in time',
): AppError {
    return { _tag: 'UpstreamTimeout', message, ...(cause !== undefined ? { cause } : {}) }
}

export function internalMessage(publicMessage = 'Internal error'): AppError {
    return internal(undefined, publicMessage)
}

export function appErrorMessage(error: AppError): string {
    return error._tag === 'Internal' ? error.publicMessage : error.message
}

export function appErrorReason(error: AppError): string | undefined {
    return 'reason' in error ? error.reason : undefined
}

export function appErrorRetryAfterSeconds(error: AppError): number | undefined {
    return 'retryAfterSeconds' in error ? error.retryAfterSeconds : undefined
}

export function appErrorCode(error: AppError): AppErrorCode {
    return APP_ERROR_CODE_MAP[error._tag]
}

export function appErrorStatus(error: AppError): number {
    return APP_ERROR_STATUS_MAP[error._tag]
}
