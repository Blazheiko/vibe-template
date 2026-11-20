// feat-236 (Р2, Р4): the closed catalog of the notifications a user receives, the categories they
// belong to and the channels each category may use. Plain data with no schema library: the
// frontend imports it for texts and preferences, and ArkType stays out of its bundle. The schemas
// of the `params` of each kind live in `shared/schemas` (notifications/params.ts); the backend
// checks them before a notification is stored.

import type { OAuthProvider } from '../responses/oauth-controller.js'

export const NOTIFICATION_CATEGORIES = ['security', 'support'] as const
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number]

export const NOTIFICATION_CHANNELS = ['push', 'email'] as const
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number]

/**
 * No params. An object type with no keys on purpose: it is what the schema of such a kind infers
 * (`type({ '+': 'reject' })`), checked in schemas/notifications/params.ts.
 */
// eslint-disable-next-line @typescript-eslint/no-generated-empty-object-type -- see above
export type NoNotificationParams = Record<never, never>

/** What each kind carries (Р2, Р9): a device label and a provider id, never IP, email or UA. */
export interface NotificationParamsMap {
    'security.new_sign_in': { device: string }
    'security.method_added': { provider: OAuthProvider }
    'security.method_removed': { provider: OAuthProvider }
    'security.password_changed': NoNotificationParams
    'security.password_reset': NoNotificationParams
    'security.logout_all': NoNotificationParams
    'security.session_revoked': { device?: string }
    'security.account_claimed': NoNotificationParams
    'support.reply': NoNotificationParams
}

export type NotificationKind = keyof NotificationParamsMap
export type NotificationParams<K extends NotificationKind> = NotificationParamsMap[K]

interface NotificationKindDefinition {
    readonly category: NotificationCategory
    /** The page the notification opens (Р7); a relative path of this application. */
    readonly link: string | null
}

const SESSIONS_PAGE = '/account#sessions'
const ACCOUNT_PAGE = '/account'

export const NOTIFICATION_KINDS = {
    'security.new_sign_in': { category: 'security', link: SESSIONS_PAGE },
    'security.method_added': { category: 'security', link: ACCOUNT_PAGE },
    'security.method_removed': { category: 'security', link: ACCOUNT_PAGE },
    'security.password_changed': { category: 'security', link: ACCOUNT_PAGE },
    'security.password_reset': { category: 'security', link: ACCOUNT_PAGE },
    'security.logout_all': { category: 'security', link: ACCOUNT_PAGE },
    'security.session_revoked': { category: 'security', link: SESSIONS_PAGE },
    'security.account_claimed': { category: 'security', link: ACCOUNT_PAGE },
    'support.reply': { category: 'support', link: '/support' },
} as const satisfies Record<NotificationKind, NotificationKindDefinition>

export const NOTIFICATION_KIND_NAMES = Object.keys(NOTIFICATION_KINDS) as NotificationKind[]

export const notificationCategoryOf = (kind: NotificationKind): NotificationCategory =>
    NOTIFICATION_KINDS[kind].category

/**
 * The link of a notification, built by the catalog and not by the call site (Р7). Every kind of
 * the first release opens a fixed page; `params` is part of the signature for kinds that will
 * point at one object.
 */
export const buildNotificationLink = <K extends NotificationKind>(
    kind: K,
    _params: NotificationParams<K>,
): string | null => NOTIFICATION_KINDS[kind].link

/** Longest serialized `params` of one notification (Р9). */
export const NOTIFICATION_PARAMS_MAX_BYTES = 1024
/** Longest string value in `params` (Р9). */
export const NOTIFICATION_PARAM_MAX_LENGTH = 128
/** Longest stored `link` (`notifications.link` is `varchar(512)`). */
export const NOTIFICATION_LINK_MAX_LENGTH = 512

/** Page sizes of GET /notifications (Р6). */
export const NOTIFICATIONS_PAGE_DEFAULT = 20
export const NOTIFICATIONS_PAGE_MAX = 50
/** The unread count stops at this number; the client shows "99+" (Р6). */
export const NOTIFICATIONS_UNREAD_COUNT_CAP = 100

/**
 * The `reason` of a 400 for PUT /notifications/preferences (Р4): the channel is locked on, or
 * the category does not have it.
 */
export const NOTIFICATION_CHANNEL_LOCKED_REASON = 'channel_locked'
export const NOTIFICATION_CHANNEL_UNAVAILABLE_REASON = 'channel_unavailable'

interface ChannelPolicy {
    /** A locked channel is always on: the user cannot turn it off (Р4). */
    readonly locked: boolean
    readonly default: boolean
}

/**
 * The channels of each category (Р4). The history in the application is not a channel: it is
 * always on. A channel absent here does not exist for the category, and a request to change it
 * is refused.
 */
export const NOTIFICATION_CHANNEL_POLICY: Readonly<
    Record<NotificationCategory, Partial<Record<NotificationChannel, ChannelPolicy>>>
> = {
    security: {
        push: { locked: false, default: true },
        // The security mails of the kinds that send one (Р2): the only notice when somebody who
        // took over the account has already turned the push off.
        email: { locked: true, default: true },
    },
    support: {
        push: { locked: false, default: true },
    },
}

export interface NotificationPreferenceRow {
    category: string
    channel: string
    enabled: boolean
}

export interface NotificationPreference {
    category: NotificationCategory
    channel: NotificationChannel
    enabled: boolean
    locked: boolean
}

export const channelPolicyOf = (
    category: NotificationCategory,
    channel: NotificationChannel,
): ChannelPolicy | undefined => NOTIFICATION_CHANNEL_POLICY[category][channel]

/**
 * The full matrix of a user (Р4): every channel the policy has, in catalog order. A stored row
 * overrides the default; a locked channel is always its default, whatever is stored.
 */
export const resolveNotificationPreferences = (
    rows: readonly NotificationPreferenceRow[],
): NotificationPreference[] => {
    const result: NotificationPreference[] = []
    for (const category of NOTIFICATION_CATEGORIES) {
        for (const channel of NOTIFICATION_CHANNELS) {
            const policy = channelPolicyOf(category, channel)
            if (policy === undefined) continue
            const stored = rows.find((row) => row.category === category && row.channel === channel)
            const enabled = policy.locked ? policy.default : (stored?.enabled ?? policy.default)
            result.push({ category, channel, enabled, locked: policy.locked })
        }
    }
    return result
}

/**
 * Whether a link may be stored (Р7): a path of this application starting with exactly one `/`,
 * with no scheme or host. A query and a fragment are allowed. Stricter than what the service
 * worker opens (`resolveNotificationTarget` also takes a same-origin URL and a path without `/`):
 * this narrows what the server writes, not what an older push may carry.
 */
export const isNotificationLink = (value: unknown): value is string => {
    if (typeof value !== 'string') return false
    if (value.length === 0 || value.length > NOTIFICATION_LINK_MAX_LENGTH) return false
    if (!value.startsWith('/')) return false
    const second = value.charAt(1)
    if (second === '/' || second === '\\') return false
    // No control characters or whitespace: a browser strips some of them and may read the rest
    // as another address.
    for (const char of value) {
        const code = char.charCodeAt(0)
        if (code <= 0x20 || code === 0x7f) return false
    }
    return !value.includes('\\')
}
