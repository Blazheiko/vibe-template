import type { ValidationErrorDetails } from 'shared/errors'
import type { ValidationIssue } from '#vendor/contracts/validator.js'
import { HttpError } from '#vendor/utils/network/errors/http-error.js'

/**
 * Request validation failure (422), independent of the validation engine:
 * `messages` are human-readable lines, `issues` (when the validator reports them)
 * map each problem to a field path.
 */
export class ValidationError extends HttpError {
    public readonly code = 'validation_failed'
    public readonly statusCode = 422
    public readonly messages: string[]
    public readonly issues: ValidationIssue[] | undefined

    constructor(messages: string[], message?: string, issues?: ValidationIssue[]) {
        super(message ?? 'Validation failure')
        this.name = 'ValidationError'
        this.messages = messages
        this.issues = issues
    }

    override get publicMessage(): string {
        return 'Validation failure'
    }

    override details(): ValidationErrorDetails {
        return {
            kind: 'validation',
            messages: this.messages,
            ...(this.issues !== undefined ? { issues: this.issues } : {}),
        }
    }
}
