import { type } from '@arktype/type'
import { UA_DEVICE_TYPES } from '../utils/user-agent.js'
import { CanonicalErrorResponseSchema, type WithCanonicalError } from './error-response.js'

/**
 * How a session was signed in (feat-233, Р3): a password (email or phone), an OAuth provider (its
 * name in `provider`), or the registration that created the account. A renewed session (password
 * change, "end all other sessions") keeps the method it was signed in with.
 */
export const SIGN_IN_METHODS = ['password', 'oauth', 'register', 'passkey'] as const
export type SignInMethod = (typeof SIGN_IN_METHODS)[number]

/**
 * The public id of a session: 22 base64url characters of an HMAC of the session id (Р5). The
 * session id itself is never sent.
 */
export const SessionPublicIdSchema = type(/^[\w-]{22}$/)

/**
 * One active session of the user (Р7). `browser` / `os` come from the User-Agent (`unknown` when
 * it cannot be told); `userAgent` and `ip` are shown as stored. `lastSeenAt` is accurate to an
 * hour (Р4); `online` means a WebSocket of this session is open on the instance that answered (Р13).
 */
export const SessionViewSchema = type({
    id: SessionPublicIdSchema,
    current: 'boolean',
    browser: 'string',
    os: 'string',
    deviceType: type.enumerated(...UA_DEVICE_TYPES),
    userAgent: 'string',
    ip: 'string',
    method: type.enumerated(...SIGN_IN_METHODS),
    provider: 'string | null',
    signedInAt: 'string',
    lastSeenAt: 'string | null',
    online: 'boolean',
})
export type SessionView = typeof SessionViewSchema.infer

/**
 * A page of the user's sessions, newest first. `current` is set on the first page only (no
 * cursor) and is never among `others`. `nextCursor` is null once the list is exhausted; a page may
 * be shorter than 50, even empty, and still have one (Р7): ask again with it.
 */
export const ListSessionsResponseSchema = type.or(
    {
        status: "'success'",
        current: SessionViewSchema.or('null'),
        others: SessionViewSchema.array(),
        nextCursor: 'string | null',
    },
    CanonicalErrorResponseSchema,
)
export type ListSessionsResponse = WithCanonicalError<typeof ListSessionsResponseSchema.infer>

export const RevokeSessionResponseSchema = type.or(
    { status: "'success'" },
    CanonicalErrorResponseSchema,
)
export type RevokeSessionResponse = WithCanonicalError<typeof RevokeSessionResponseSchema.infer>

/**
 * "End all other sessions" (Р9). The other sessions are ended in both success branches;
 * `sessionRenewed: false` means this session could not be renewed afterwards and the client signs
 * in again, as after a password change.
 */
export const RevokeOtherSessionsResponseSchema = type.or(
    {
        status: "'success'",
        sessionRenewed: 'true',
        csrfToken: 'string',
        wsUrl: 'string',
        wsToken: 'string',
    },
    { status: "'success'", sessionRenewed: 'false' },
    CanonicalErrorResponseSchema,
)
export type RevokeOtherSessionsResponse = WithCanonicalError<
    typeof RevokeOtherSessionsResponseSchema.infer
>
