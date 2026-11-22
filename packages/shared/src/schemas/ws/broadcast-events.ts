import { type } from '@arktype/type'
import { EntityIdSchema } from '../../brands/index.js'
import { WSAdminUserOnlineUpsertPayloadSchema } from './ws-admin-user-online-upsert.js'
import { ProfileSchema } from '../../responses/account-controller.js'
import { RoleSchema } from '../../access/role-schema.js'

// Payloads of the events the backend pushes without a request (`broadcast:<event>`),
// docs/plan/archive/ws-async-message-validation-plan.md §4.1. The backend checks every event
// against its schema before sending; the frontend checks it with hand-written guards
// (no ArkType in the bundle) kept in sync by a parity test. Schemas describe JSON:
// no Date, bigint or morphs, and no '+': 'reject' — the backend mode decides on keys.
export const BroadcastEventSchemas = {
    // `clientMessageId` is the id the client gave the message this answer is for (absent for
    // the greeting): an event of an older answer must not end a newer one.
    support_chat_token: type({ token: 'string', 'clientMessageId?': 'string' }),
    support_chat_complete: type({
        content: 'string',
        screenshots: 'string[]',
        'clientMessageId?': 'string',
    }),
    // `code` tells a failure after the message was accepted apart from another
    // ('chat_failed', 'open_chat_failed', 'chat_interrupted', 'message_already_received'); a
    // refusal before that is the reply to the request.
    support_chat_error: type({
        message: 'string',
        'code?': 'string',
        'clientMessageId?': 'string',
    }),
    admin_user_online_upsert: WSAdminUserOnlineUpsertPayloadSchema,
    admin_user_online_remove: type({ id: EntityIdSchema }),
    // feat-232 (Р9 B): the profile after a change, to every connection of the user on every
    // instance, the one that changed it included. Applied by `revision`: an older one is dropped.
    user_profile_updated: ProfileSchema,
    // feat-233 (Р12): the user's session list changed (a sign-in, a renewal, an ended session, a
    // socket of a session opened or closed). No data: the client reads the first page again.
    user_sessions_changed: type({}),
    // feat-236 (Р8): the notifications of the user changed (a new one, one or all read). A signal
    // with no data: a value could be older than the answer to a read the client already has.
    notifications_changed: type({}),
    // feat-236 (Р8): the notification preferences changed; an open matrix reads them again.
    notification_preferences_changed: type({}),
    // feat-240 (Р8): the role of this connection changed; sent to the socket after the role was
    // applied to it, so a request the client sends next is checked against this role.
    // feat-247 (Р11): `reason` when the role stays and the staff MFA proof of the session went
    // stale: the admin channel was left and staff permissions refuse until a new proof.
    access_changed: type({ role: RoleSchema, 'reason?': "'mfa_session_required'" }),
    // feat-240 (Р8): the admin channel of this connection, paused after a failed role read, may
    // be joined again; the client decides, it knows whether the admin area is still open.
    admin_channel_ready: type({}),
} as const

export type BroadcastEventName = keyof typeof BroadcastEventSchemas

export type BroadcastPayload<E extends BroadcastEventName> =
    (typeof BroadcastEventSchemas)[E]['inferIn']

// One event with its payload, as a union of pairs: a union of names cannot be passed
// with a union of payloads, so the pair stays linked even for a non-literal event.
export type BroadcastMessage = {
    [E in BroadcastEventName]: [event: E, payload: BroadcastPayload<E>]
}[BroadcastEventName]

export const BROADCAST_EVENT_NAMES = Object.keys(BroadcastEventSchemas) as BroadcastEventName[]
