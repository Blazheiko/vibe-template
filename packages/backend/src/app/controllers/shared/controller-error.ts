import { Result } from 'better-result'
import type { HttpContext, WsContext } from '#vendor/types/types.js'
import { appErrorToPayload } from '#app/services/shared/app-error-payload.js'
import { applyAppErrorStatus } from '#app/services/shared/apply-service-status.js'
import { appErrorStatus, type AppError, type AppResult } from '#app/services/shared/errors.js'
import { reportAppError } from '#app/services/shared/report-app-error.js'

/**
 * Logs a 5xx AppError through the request logger (see reportAppError). For a
 * controller that answers an error without mapControllerError, such as the OAuth
 * callback redirect. A client that went away reads no answer: its cancelled work
 * is not a server failure.
 */
export const reportControllerError = (
    context: { logger: HttpContext['logger']; signal: AbortSignal },
    error: AppError,
): void => {
    if (!context.signal.aborted) reportAppError(context.logger, error)
}

export function mapControllerError(
    context: Pick<HttpContext<unknown, unknown>, 'responseData' | 'logger' | 'signal'>,
    error: AppError,
): ReturnType<typeof appErrorToPayload> {
    applyAppErrorStatus(context.responseData, error)
    reportControllerError(context, error)
    return appErrorToPayload(error)
}

/** The WS counterpart: the status goes into the reply, the error body into `data`. */
export function mapWsControllerError(
    context: Pick<WsContext, 'responseData' | 'logger' | 'signal'>,
    error: AppError,
): ReturnType<typeof appErrorToPayload> {
    context.responseData.status = String(appErrorStatus(error))
    reportControllerError(context, error)
    return appErrorToPayload(error)
}

type HttpErrorContext = Pick<HttpContext<unknown, unknown>, 'responseData' | 'logger' | 'signal'>
type ErrorPayload = ReturnType<typeof appErrorToPayload>

/**
 * The usual end of a controller method: an error becomes the canonical error answer
 * (mapControllerError), a value becomes the body, as is or through `toBody`.
 */
export function respond<T>(context: HttpErrorContext, result: AppResult<T>): T | ErrorPayload
export function respond<T, R>(
    context: HttpErrorContext,
    result: AppResult<T>,
    toBody: (value: T) => R,
): R | ErrorPayload
export function respond<T, R>(
    context: HttpErrorContext,
    result: AppResult<T>,
    toBody?: (value: T) => R,
): T | R | ErrorPayload {
    if (Result.isError(result)) return mapControllerError(context, result.error)
    return toBody === undefined ? result.value : toBody(result.value)
}

/** The WS counterpart of `respond` (mapWsControllerError for an error). */
export function respondWs<T>(
    context: Pick<WsContext, 'responseData' | 'logger' | 'signal'>,
    result: AppResult<T>,
): T | ErrorPayload
export function respondWs<T, R>(
    context: Pick<WsContext, 'responseData' | 'logger' | 'signal'>,
    result: AppResult<T>,
    toBody: (value: T) => R,
): R | ErrorPayload
export function respondWs<T, R>(
    context: Pick<WsContext, 'responseData' | 'logger' | 'signal'>,
    result: AppResult<T>,
    toBody?: (value: T) => R,
): T | R | ErrorPayload {
    if (Result.isError(result)) return mapWsControllerError(context, result.error)
    return toBody === undefined ? result.value : toBody(result.value)
}
