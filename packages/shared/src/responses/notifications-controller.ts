import { type } from '@arktype/type'
import { NOTIFICATION_CATEGORIES, NOTIFICATION_CHANNELS } from '../notifications/catalog.js'
import { NotificationParamsSchemas } from '../schemas/notifications/params.js'
import { CanonicalErrorResponseSchema, type WithCanonicalError } from './error-response.js'
import { EntityIdStringSchema } from '../brands/ids.js'

const IdSchema = EntityIdStringSchema
const UnreadCountSchema = 'number.integer >= 0'

const ItemBase = type({
    id: IdSchema,
    link: 'string | null',
    createdAt: 'string',
    readAt: 'string | null',
})
const P = NotificationParamsSchemas

/**
 * One notification of the user (feat-236, Р1, Р3). The text is built by the client from `kind`
 * and `params` in the language of the interface; `link` is the page it opens (Р7). One branch per
 * kind of the catalog (checked in shared/test/notifications.test.js).
 */
export const NotificationItemSchema = type.or(
    ItemBase.and({
        kind: "'security.new_sign_in'",
        category: "'security'",
        params: P['security.new_sign_in'],
    }),
    ItemBase.and({
        kind: "'security.method_added'",
        category: "'security'",
        params: P['security.method_added'],
    }),
    ItemBase.and({
        kind: "'security.method_removed'",
        category: "'security'",
        params: P['security.method_removed'],
    }),
    ItemBase.and({
        kind: "'security.password_changed'",
        category: "'security'",
        params: P['security.password_changed'],
    }),
    ItemBase.and({
        kind: "'security.password_reset'",
        category: "'security'",
        params: P['security.password_reset'],
    }),
    ItemBase.and({
        kind: "'security.logout_all'",
        category: "'security'",
        params: P['security.logout_all'],
    }),
    ItemBase.and({
        kind: "'security.session_revoked'",
        category: "'security'",
        params: P['security.session_revoked'],
    }),
    ItemBase.and({
        kind: "'security.account_claimed'",
        category: "'security'",
        params: P['security.account_claimed'],
    }),
    ItemBase.and({
        kind: "'support.reply'",
        category: "'support'",
        params: P['support.reply'],
    }),
)
export type NotificationItem = typeof NotificationItemSchema.infer

/** A page of the history, newest first (Р6). `next` is the `before` of the next page. */
export const ListNotificationsResponseSchema = type.or(
    {
        status: "'success'",
        items: NotificationItemSchema.array(),
        next: IdSchema.or('null'),
        unreadCount: UnreadCountSchema,
    },
    CanonicalErrorResponseSchema,
)
export type ListNotificationsResponse = WithCanonicalError<
    typeof ListNotificationsResponseSchema.infer
>

/** The unread count, capped at 100 (Р6). */
export const UnreadNotificationsCountResponseSchema = type.or(
    { status: "'success'", unreadCount: UnreadCountSchema },
    CanonicalErrorResponseSchema,
)
export type UnreadNotificationsCountResponse = WithCanonicalError<
    typeof UnreadNotificationsCountResponseSchema.infer
>

/**
 * POST /notifications/:id/read (Р6, Р7). The same answer for a notification read already: what
 * the page that opens it needs, with no list loaded.
 */
export const MarkNotificationReadResponseSchema = type.or(
    { status: "'success'", link: 'string | null', unreadCount: UnreadCountSchema },
    CanonicalErrorResponseSchema,
)
export type MarkNotificationReadResponse = WithCanonicalError<
    typeof MarkNotificationReadResponseSchema.infer
>

export const ReadAllNotificationsResponseSchema = UnreadNotificationsCountResponseSchema
export type ReadAllNotificationsResponse = UnreadNotificationsCountResponse

/** One cell of the preferences matrix (Р4): a locked channel is shown but cannot be changed. */
export const NotificationPreferenceSchema = type({
    category: type.enumerated(...NOTIFICATION_CATEGORIES),
    channel: type.enumerated(...NOTIFICATION_CHANNELS),
    enabled: 'boolean',
    locked: 'boolean',
})

export const NotificationPreferencesResponseSchema = type.or(
    { status: "'success'", preferences: NotificationPreferenceSchema.array() },
    CanonicalErrorResponseSchema,
)
export type NotificationPreferencesResponse = WithCanonicalError<
    typeof NotificationPreferencesResponseSchema.infer
>
