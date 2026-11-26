import type { Cursor, EntityId, IsoDateTime, SessionPublicId } from 'shared/brand'
import type { User } from '@/stores/user'

// Wire values for fixtures (feat-268, plan Р8): the response types brand them, and a test names
// them by plain text. Tests may cast (ADR 0007); these keep the casts in one place and check
// nothing, so a test can also build a value the schema would refuse.

export const asEntityId = (id: string | number): EntityId => String(id) as EntityId
export const asIsoDateTime = (text: string): IsoDateTime => text as IsoDateTime
export const asSessionPublicId = (text: string): SessionPublicId => text as SessionPublicId
export const asCursor = (text: string): Cursor => text as Cursor

/** A signed-in user of the store for a test: the fields a sign-in always answers, then `fields`. */
export const testUser = (fields: Partial<User> & { id: EntityId }): User => ({
    name: 'Test User',
    emailVerified: true,
    ...fields,
})
