// Wire values the backend makes itself (feat-268, plan Р8): the response schemas brand them, and
// these constructors give them out where the text comes from a trusted source (the database, the
// session store, a cursor the server encoded). The shapes are checked by the schemas in
// `shared/brands`; nothing here parses client input.

import {
    isValidEntityId,
    type Cursor,
    type EntityId,
    type IsoDateTime,
    type SessionPublicId,
} from 'shared/brand'

/** ISO 8601 text the server wrote itself (`toISOString`, stored in a session). */
export const asIsoDateTime = (text: string): IsoDateTime => text as IsoDateTime

/** A PostgreSQL `timestamp` printed in UTC without a zone, as ISO 8601; microseconds are kept. */
export const isoDateTimeOfPgText = (text: string): IsoDateTime =>
    `${text.replace(' ', 'T')}Z` as IsoDateTime

/** A page cursor the server encoded; the client only sends it back. */
export const asCursor = (text: string): Cursor => text as Cursor

/** The public id of a session as the session store keeps it. */
export const asSessionPublicId = (text: string): SessionPublicId => text as SessionPublicId

/**
 * An id the database keeps as text (`audit_events.target_id`). Only canonical ids are written, so
 * anything else is a bug and throws instead of reaching a client.
 */
export function entityIdOfText(text: string): EntityId {
    if (!isValidEntityId(text)) throw new Error(`not an entity id: ${JSON.stringify(text)}`)
    return text as EntityId
}
