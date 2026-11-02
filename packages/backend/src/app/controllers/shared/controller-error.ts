import type { HttpContext } from '#vendor/types/types.js'
import { appErrorToPayload } from '#app/services/shared/app-error-payload.js'
import { applyAppErrorStatus } from '#app/services/shared/apply-service-status.js'
import { type AppError } from '#app/services/shared/errors.js'

export function mapControllerError(
    context: Pick<HttpContext<unknown, unknown>, 'responseData'>,
    error: AppError,
): ReturnType<typeof appErrorToPayload> {
    applyAppErrorStatus(context.responseData, error)
    return appErrorToPayload(error)
}
