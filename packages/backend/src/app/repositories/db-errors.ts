const UNIQUE_VIOLATION = '23505'

const codeOf = (value: unknown): unknown =>
    typeof value === 'object' && value !== null && 'code' in value ? value.code : undefined

/**
 * True when PostgreSQL rejected a write by a unique index. The driver error may arrive as
 * is or wrapped by Drizzle (DrizzleQueryError keeps it as `cause`).
 */
export const isUniqueViolation = (err: unknown): boolean =>
    codeOf(err) === UNIQUE_VIOLATION ||
    (err instanceof Error && codeOf(err.cause) === UNIQUE_VIOLATION)

const SQLSTATE = /^[0-9A-Z]{5}$/

/**
 * feat-130: true when PostgreSQL itself answered the statement with an error (the driver error,
 * as is or wrapped by Drizzle, carries a SQLSTATE `code`): the transaction is rolled back. False
 * when no answer came (a client timeout, a dropped connection): the COMMIT may have gone through
 * and may not even be visible to another connection yet.
 */
export const isServerRejection = (err: unknown): boolean => {
    const rejected = (value: unknown): boolean => {
        const code = codeOf(value)
        return typeof code === 'string' && SQLSTATE.test(code)
    }
    return rejected(err) || (err instanceof Error && rejected(err.cause))
}
