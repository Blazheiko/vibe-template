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
