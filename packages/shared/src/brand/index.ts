// Branded types without a library (feat-262, ADR 0007 in feat-263): the browser may import this
// module as a value, so it imports nothing but the shared patterns. `shared/brands` keeps the
// ArkType schemas; the frontend takes only types from there (check-bundle-graph).

import { ENTITY_ID_PATTERN } from '../patterns/index.js'

declare const brandKey: ' brand'

/**
 * A primitive `T` that only a constructor or a schema gives out, told apart by `Id`. The shape is
 * the one ArkType's `.brand()` infers (`@ark/util` `Brand`), so a schema's output and a value
 * branded here are the same type; `brands/type-checks.ts` stops the build if the two drift apart.
 */
export type Brand<T, Id> = T & { readonly [brandKey]: [T, Id] }

/** The largest value of a PostgreSQL `bigint` (and of every id column), as its decimal text. */
export const MAX_ENTITY_ID = '9223372036854775807'

/**
 * Whether `value` is the canonical id of a row: decimal digits, no leading zero, not zero, and no
 * larger than a PostgreSQL `bigint` holds. The bound is a string comparison of two 19-digit
 * numbers, so the check needs no `BigInt` and runs the same in the browser.
 */
export function isValidEntityId(value: string): boolean {
    return (
        ENTITY_ID_PATTERN.test(value) &&
        (value.length < MAX_ENTITY_ID.length || value <= MAX_ENTITY_ID)
    )
}
