// Wire values the backend makes itself (feat-268, plan Р8): the response schemas brand them, and
// these constructors give them out where the text comes from a trusted source (the database, the
// session store, a cursor the server encoded). The shapes are checked by the schemas in
// `shared/brands`; nothing here parses client input.

import type { Cursor, IsoDateTime, SessionPublicId } from 'shared/brand'

/** ISO 8601 text the server wrote itself (`toISOString`, stored in a session). */
export const asIsoDateTime = (text: string): IsoDateTime => text as IsoDateTime

/** A PostgreSQL `timestamp` printed in UTC without a zone, as ISO 8601; microseconds are kept. */
export const isoDateTimeOfPgText = (text: string): IsoDateTime =>
    `${text.replace(' ', 'T')}Z` as IsoDateTime

/** A page cursor the server encoded; the client only sends it back. */
export const asCursor = (text: string): Cursor => text as Cursor

/** The public id of a session as the session store keeps it. */
export const asSessionPublicId = (text: string): SessionPublicId => text as SessionPublicId
