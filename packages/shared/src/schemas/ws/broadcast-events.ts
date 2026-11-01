import { type } from '@arktype/type'
import { EntityIdSchema } from '../../brands/index.js'
import { WSAdminUserOnlineUpsertPayloadSchema } from './ws-admin-user-online-upsert.js'

// Payloads of the events the backend pushes without a request (`broadcast:<event>`),
// docs/plan/ws-async-message-validation-plan.md §4.1. The backend checks every event
// against its schema before sending; the frontend checks it with hand-written guards
// (no ArkType in the bundle) kept in sync by a parity test. Schemas describe JSON:
// no Date, bigint or morphs, and no '+': 'reject' — the backend mode decides on keys.
export const BroadcastEventSchemas = {
    support_chat_token: type({ token: 'string' }),
    support_chat_complete: type({ content: 'string', screenshots: 'string[]' }),
    // `code` tells a failure after the message was accepted apart from another
    // ('chat_failed', 'open_chat_failed'); a refusal before that is the reply to the request.
    support_chat_error: type({ message: 'string', 'code?': 'string' }),
    admin_user_online_upsert: WSAdminUserOnlineUpsertPayloadSchema,
    admin_user_online_remove: type({ id: EntityIdSchema }),
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
