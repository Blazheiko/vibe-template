// Constructors of the branded row ids (feat-263, ADR 0007, plan Р4). Ids from outside (a path,
// a query, a session) become branded only here, after isValidEntityId; a row read from the
// database is branded by its column type already. One constructor per brand: a generic
// parseId<B> would let the caller pick the brand, which is the same unchecked cast.
//
// No # imports in app/domain (plan Р3, Р10): database/schema.ts may import these modules with a
// relative path, and drizzle-kit loads the schema without the aliases.

import { isValidEntityId } from 'shared/brand'

import type { OAuthAccountId, UserId } from '../../database/ids.js'

export type { OAuthAccountId, UserId } from '../../database/ids.js'

const parse = (raw: string | null | undefined): bigint | null =>
    typeof raw === 'string' && isValidEntityId(raw) ? BigInt(raw) : null

/** The id of a user from its decimal text, or null when the text is not a row id. */
export const parseUserId = (raw: string | null | undefined): UserId | null =>
    parse(raw) as UserId | null

/**
 * The id of a user from text the app wrote itself and already checked: the user id of a signed-in
 * session (`auth.getUserId()` returns only a row id), of a WS connection or of an MFA ticket.
 * Text that is not a row id there means corrupted state, so it throws instead of guessing.
 */
export const asUserId = (raw: string): UserId => {
    const id = parseUserId(raw)
    if (id === null) throw new Error('asUserId: not a row id')
    return id
}

/** The id of an OAuth link from its decimal text, or null when the text is not a row id. */
export const parseOAuthAccountId = (raw: string | null | undefined): OAuthAccountId | null =>
    parse(raw) as OAuthAccountId | null

/** The decimal text of a row id, as it goes into a response, a session or a WS payload. */
export const toEntityId = (id: bigint): string => String(id)
