import { type } from '@arktype/type'

// Response values the client only reads or sends back (feat-268, plan Р8). The same types are
// in `shared/brand`, where the backend brands values it made itself.

/** ISO 8601 text of a moment; the server writes `Date.prototype.toISOString`. */
export const IsoDateTimeSchema = type('string.date.iso').brand('IsoDateTime')
export type IsoDateTime = typeof IsoDateTimeSchema.infer

/** An opaque page cursor: the server makes it, the client sends it back unchanged. */
export const CursorSchema = type('string').brand('Cursor')
export type Cursor = typeof CursorSchema.infer

/**
 * The public id of a session: 22 base64url characters of an HMAC of the session id (feat-233,
 * Р5). The session id itself is never sent.
 */
export const SessionPublicIdSchema = type(/^[\w-]{22}$/).brand('SessionPublicId')
export type SessionPublicId = typeof SessionPublicIdSchema.infer
