// The id of a row, read from a path parameter or the query string.
//
// The columns are PostgreSQL `bigint`. A value that is not a plain decimal number, or one
// PostgreSQL cannot hold, is not an id of anything: it is answered like a missing or malformed
// id by the caller (400 or 404), instead of reaching the query and coming back as a 500
// ("value out of range for type bigint", feat-161). `BigInt()` alone is too lenient: it also
// takes `0x10`, `-5` and an empty string.

const MAX_POSTGRES_BIGINT = 9223372036854775807n

export const parseEntityId = (raw: string | null | undefined): bigint | null => {
    if (raw === undefined || raw === null || !/^\d{1,19}$/.test(raw)) return null
    const id = BigInt(raw)
    return id <= MAX_POSTGRES_BIGINT ? id : null
}
