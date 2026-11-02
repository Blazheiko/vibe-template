import type { AppError, AppErrorCode } from './errors.js'
import { appErrorCode, appErrorMessage, appErrorReason } from './errors.js'

// The body a client gets for an AppError, over HTTP and over WebSocket alike. A type, not an
// interface: it is assigned to Record-shaped payload types, which needs the implicit index
// signature only type aliases have.
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type AppErrorPayload = {
    status: 'error'
    message: string
    code: AppErrorCode
    reason?: string
}

export function appErrorToPayload(error: AppError): AppErrorPayload {
    const reason = appErrorReason(error)

    return {
        status: 'error',
        message: appErrorMessage(error),
        code: appErrorCode(error),
        ...(reason !== undefined ? { reason } : {}),
    }
}
