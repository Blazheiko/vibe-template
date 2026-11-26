import type { UserId } from '#app/domain/ids.js'

/**
 * A user id for a test (feat-263): fixtures and mocks name users by small numbers. Tests may brand
 * a value directly (ADR 0007, no-brand-cast exempts them); this keeps the cast in one place.
 */
export const uid = (n: bigint | number): UserId => BigInt(n) as UserId
