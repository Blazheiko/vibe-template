import type { HttpContext, WsContext } from '#vendor/types/types.js'
import { appErrorToPayload } from '#app/services/shared/app-error-payload.js'
import { applyAppErrorStatus } from '#app/services/shared/apply-service-status.js'
import { appErrorStatus, type AppError } from '#app/services/shared/errors.js'
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
