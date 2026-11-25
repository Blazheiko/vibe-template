import { isValidEntityId } from 'shared/brand'

// The id of a row, read from a path parameter or the query string.
//
// The columns are PostgreSQL `bigint`. A value that is not the canonical id of a row is not an
// id of anything: it is answered like a missing or malformed id by the caller (400 or 404),
// instead of reaching the query and coming back as a 500 ("value out of range for type bigint",
// feat-161). `BigInt()` alone is too lenient: it also takes `0x10`, `-5` and an empty string.
// `isValidEntityId` (feat-262) is the one check the schemas, this parser and the frontend share:
// digits, no leading zero, not zero, no larger than a bigint holds.

export const parseEntityId = (raw: string | null | undefined): bigint | null =>
    typeof raw === 'string' && isValidEntityId(raw) ? BigInt(raw) : null
