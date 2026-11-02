import type { ResponseData } from '#vendor/types/types.js'
import type { AppError } from './errors.js'
import { appErrorRetryAfterSeconds, appErrorStatus } from './errors.js'

export function applyAppErrorStatus(responseData: ResponseData, error: AppError): void {
    responseData.status = appErrorStatus(error)

    const retryAfterSeconds = appErrorRetryAfterSeconds(error)
    if (retryAfterSeconds !== undefined) {
        responseData.setHeader('Retry-After', String(retryAfterSeconds))
    }
}
