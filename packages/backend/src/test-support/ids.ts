import type { EntityId } from 'shared/brand'
import type { UserId } from '#app/domain/ids.js'

/**
 * A user id for a test (feat-263): fixtures and mocks name users by small numbers. Tests may brand
 * a value directly (ADR 0007, no-brand-cast exempts them); this keeps the cast in one place.
 */
export const uid = (n: bigint | number): UserId => BigInt(n) as UserId

/** An id as the wire carries it (feat-268): broadcast payloads and responses brand it. */
export const eid = (n: bigint | number | string): EntityId => String(n) as EntityId
