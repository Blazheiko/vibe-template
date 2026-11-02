/**
 * Validates URL path parameters using regex and length constraints.
 */

import type { ParameterValidationErrorDetails } from 'shared/errors'
import { HttpError } from '#vendor/utils/network/errors/http-error.js'

/**
 * Error class for parameter validation failures
 */
export class ParameterValidationError extends HttpError {
    public readonly code = 'bad_request'
    public readonly statusCode = 400
    public readonly parameterName: string
    public readonly parameterValue: string

    constructor(parameterName: string, parameterValue: string, message?: string) {
        super(message ?? `Invalid parameter: ${parameterName} with value: ${parameterValue}`)
        this.name = 'ParameterValidationError'
        this.parameterName = parameterName
        this.parameterValue = parameterValue
    }

    override get publicMessage(): string {
        return 'Invalid parameter'
    }

    override details(): ParameterValidationErrorDetails {
        return {
            kind: 'parameter_validation',
            parameter: this.parameterName,
            messages: [this.message],
        }
    }
}

const PARAMETER_MAX_LENGTH = 256
const PARAMETER_PATTERN = /^[a-zA-Z0-9\-_./]*$/

/**
 * Validates URL path parameter value
 * @param value - Parameter value to validate
 * @param parameterName - Name of the parameter being validated
 * @throws {ParameterValidationError} When parameter validation fails
 */
export function validateParameter(value: string, parameterName?: string): void {
    const paramName = parameterName ?? 'unknown'

    if (value.length === 0) return

    if (value.length > PARAMETER_MAX_LENGTH) {
        throw new ParameterValidationError(
            paramName,
            value,
            `Parameter '${paramName}' validation failed: must be at most ${String(PARAMETER_MAX_LENGTH)} characters`,
        )
    }

    if (!PARAMETER_PATTERN.test(value)) {
        throw new ParameterValidationError(
            paramName,
            value,
            `Parameter '${paramName}' validation failed: contains invalid characters`,
        )
    }
}
