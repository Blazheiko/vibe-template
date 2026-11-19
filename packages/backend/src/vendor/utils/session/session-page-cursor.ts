import { isSessionPublicId } from '#vendor/utils/session/session-public-id.js'

/**
 * feat-233 (Р7): a place in the session index, ordered by (createdAt desc, publicId desc): Redis
 * orders equal scores of ZREVRANGEBYSCORE in reverse lexicographic order of the members.
 */
export interface IndexPosition {
    createdAtMs: number
    publicId: string
}

/** The opaque cursor of a page: base64url("<createdAt>:<publicId>") of the last member looked at. */
export const encodeSessionCursor = (position: IndexPosition): string =>
    Buffer.from(`${String(position.createdAtMs)}:${position.publicId}`, 'utf8').toString(
        'base64url',
    )

const CURSOR_TEXT = /^(0|[1-9]\d{0,15}):([\w-]+)$/

/** The position a cursor names, or null when it is not one this server gives out. */
export const decodeSessionCursor = (cursor: string): IndexPosition | null => {
    if (!/^[\w-]{1,128}$/.test(cursor)) return null
    const text = Buffer.from(cursor, 'base64url').toString('utf8')
    // A round trip proves the cursor is canonical base64url of that text.
    if (Buffer.from(text, 'utf8').toString('base64url') !== cursor) return null
    const match = CURSOR_TEXT.exec(text)
    if (match === null) return null
    const createdAtMs = Number(match[1])
    const publicId = match[2]
    if (!Number.isSafeInteger(createdAtMs) || !isSessionPublicId(publicId)) return null
    return { createdAtMs, publicId }
}

/** Whether `a` comes after `b` in the index order (createdAt desc, publicId desc). */
export const isAfter = (a: IndexPosition, b: IndexPosition): boolean =>
    a.createdAtMs < b.createdAtMs || (a.createdAtMs === b.createdAtMs && a.publicId < b.publicId)
