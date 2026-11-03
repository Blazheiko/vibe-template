import { ErrorCode, type ErrorCode as AppErrorCode } from 'shared/errors'

export type TransportCode = number

export type ErrorMessages = Record<string, unknown> | string[] | string

export interface NormalizedResponseError {
    code?: AppErrorCode
    transportCode: TransportCode
    status?: number | string
    message: string
    messages?: ErrorMessages
}

const ERROR_STATUS = 'error'

const isRecord = (value: unknown): value is Record<string, unknown> => {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const readString = (value: unknown): string | undefined => {
    return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

const readPayloadCode = (value: unknown): AppErrorCode | undefined => {
    if (typeof value !== 'string') return undefined
    return Object.values(ErrorCode).includes(value as AppErrorCode)
        ? (value as AppErrorCode)
        : undefined
}

const readNumericCode = (value: unknown): number | undefined => {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value
    }

    if (typeof value === 'string' && value.trim().length > 0) {
        const parsed = Number(value)
        return Number.isFinite(parsed) ? parsed : undefined
    }

    return undefined
}

const getErrorRecord = (value: unknown): Record<string, unknown> | undefined => {
    if (!isRecord(value) || !isRecord(value.error)) {
        return undefined
    }

    return value.error
}

export const getErrorCode = (value: unknown): AppErrorCode | undefined => {
    if (!isRecord(value)) {
        return undefined
    }

    const topLevelCode = readPayloadCode(value.code)
    if (topLevelCode !== undefined) {
        return topLevelCode
    }

    return readPayloadCode(getErrorRecord(value)?.code)
}

export const hasErrorCode = (value: unknown, code: AppErrorCode): boolean => {
    return getErrorCode(value) === code
}

export const getTransportCode = (value: unknown, fallbackCode?: number): number | undefined => {
    const errorRecord = getErrorRecord(value)
    const errorCode = readNumericCode(errorRecord?.code)
    if (errorCode !== undefined) {
        return errorCode
    }

    if (isRecord(value)) {
        const statusCode = readNumericCode(value.status)
        if (statusCode !== undefined) {
            return statusCode
        }
    }

    return fallbackCode
}

export const getResponseMessage = (value: unknown, fallbackMessage: string): string => {
    const errorRecord = getErrorRecord(value)

    return (
        readString(errorRecord?.message) ??
        readString(errorRecord?.reason) ??
        readString(isRecord(value) ? value.message : undefined) ??
        readString(isRecord(value) ? value.reason : undefined) ??
        fallbackMessage
    )
}

export const getResponseMessages = (value: unknown): ErrorMessages | undefined => {
    const errorRecord = getErrorRecord(value)
    const errorDetails = errorRecord?.details
    const topLevelDetails = isRecord(value) ? value.details : undefined

    const fromDetails = [errorDetails, topLevelDetails].find(
        (details) => isRecord(details) && 'messages' in details,
    ) as Record<string, unknown> | undefined

    const topLevelMessages = isRecord(value)
        ? (value.messages as ErrorMessages | undefined)
        : undefined
    const errorMessages = errorRecord?.messages as ErrorMessages | undefined

    return (fromDetails?.messages as ErrorMessages | undefined) ?? errorMessages ?? topLevelMessages
}

export const hasResponseError = (value: unknown): boolean => {
    if (getErrorRecord(value) !== undefined) {
        return true
    }

    if (!isRecord(value)) {
        return false
    }

    const status = value.status
    if (typeof status === 'number') {
        return status < 200 || status >= 300
    }

    if (typeof status === 'string') {
        const normalizedStatus = status.trim().toLowerCase()
        if (!normalizedStatus.length) {
            return false
        }

        if (normalizedStatus === ERROR_STATUS) {
            return true
        }

        const numericStatus = Number(normalizedStatus)
        return Number.isFinite(numericStatus) ? numericStatus < 200 || numericStatus >= 300 : false
    }

    return false
}

/** The machine-readable `reason` of an error answer (e.g. `password_required`), if any. */
export const getErrorReason = (value: unknown): string | undefined => {
    if (!hasResponseError(value) || !isRecord(value)) return undefined
    return readString(value.reason) ?? readString(getErrorRecord(value)?.reason)
}

export const normalizeResponseError = (
    value: unknown,
    fallbackMessage: string,
    fallbackCode?: number,
): NormalizedResponseError => {
    const transportCode = getTransportCode(value, fallbackCode) ?? fallbackCode ?? 0

    return {
        code: getErrorCode(value),
        transportCode,
        status: isRecord(value) ? (value.status as number | string | undefined) : undefined,
        message: getResponseMessage(value, fallbackMessage),
        messages: getResponseMessages(value),
    }
}

// Convenience helper only for auth-redirect style flows. It intentionally bridges
// payload-level `ErrorCode.Unauthorized` and transport-level HTTP 401.
export const isUnauthorizedError = (value: unknown, transportCode?: number): boolean => {
    return (
        hasErrorCode(value, ErrorCode.Unauthorized) ||
        (transportCode ?? getTransportCode(value)) === 401
    )
}
