import type { BroadcastContracts, BroadcastEventName } from 'shared/contracts'
import type { BroadcastPayload } from 'shared/schemas'
import { isValidEntityId, type EntityId } from 'shared/brand'
import { isRole } from 'shared/access'
import {
    COLOR_THEMES,
    FONT_SIZE_MAX,
    FONT_SIZE_MIN,
    SHIPPED_LOCALE_CODES,
    THEMES,
} from 'shared/enums'

// Hand-written guards for broadcast payloads: importing the ArkType schemas at runtime
// pulls the whole ArkType engine into the bundle (and its `new Function` JIT probe
// shows up as a CSP violation). Each guard has the contract of its schema in
// packages/shared/src/schemas/ws/broadcast-events.ts with undeclared keys rejected;
// ws-payload-guards.spec.ts checks them against the schemas.

const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)

const hasOnlyKeys = (value: Record<string, unknown>, keys: ReadonlySet<string>): boolean =>
    Object.keys(value).every((key) => keys.has(key))

// The id check the schemas use (feat-262): digits, no leading zero, up to the bigint bound. A
// value that passes is an EntityId, as the schema would brand it (feat-268).
const isEntityId = (value: unknown): value is EntityId =>
    typeof value === 'string' && isValidEntityId(value)

const TOKEN_KEYS = new Set(['token', 'clientMessageId'])
const COMPLETE_KEYS = new Set(['content', 'screenshots', 'clientMessageId'])
const ERROR_KEYS = new Set(['message', 'code', 'clientMessageId'])

const isOptionalString = (value: unknown): boolean =>
    value === undefined || typeof value === 'string'
const REMOVE_KEYS = new Set(['id'])
const ADMIN_USER_ONLINE_UPSERT_KEYS = new Set([
    'id',
    'name',
    'email',
    'appType',
    'userAgent',
    'connectionsCount',
])

export const isSupportChatTokenPayload = (
    value: unknown,
): value is BroadcastPayload<'support_chat_token'> =>
    isObject(value) &&
    hasOnlyKeys(value, TOKEN_KEYS) &&
    typeof value.token === 'string' &&
    isOptionalString(value.clientMessageId)

export const isSupportChatCompletePayload = (
    value: unknown,
): value is BroadcastPayload<'support_chat_complete'> =>
    isObject(value) &&
    hasOnlyKeys(value, COMPLETE_KEYS) &&
    typeof value.content === 'string' &&
    Array.isArray(value.screenshots) &&
    value.screenshots.every((item) => typeof item === 'string') &&
    isOptionalString(value.clientMessageId)

export const isSupportChatErrorPayload = (
    value: unknown,
): value is BroadcastPayload<'support_chat_error'> =>
    isObject(value) &&
    hasOnlyKeys(value, ERROR_KEYS) &&
    typeof value.message === 'string' &&
    isOptionalString(value.code) &&
    isOptionalString(value.clientMessageId)

export const isWSAdminUserOnlineUpsertPayload = (
    value: unknown,
): value is BroadcastPayload<'admin_user_online_upsert'> =>
    isObject(value) &&
    hasOnlyKeys(value, ADMIN_USER_ONLINE_UPSERT_KEYS) &&
    isEntityId(value.id) &&
    typeof value.name === 'string' &&
    typeof value.email === 'string' &&
    (value.appType === 'web' || value.appType === 'pwa') &&
    typeof value.userAgent === 'string' &&
    typeof value.connectionsCount === 'number'

export const isAdminUserOnlineRemovePayload = (
    value: unknown,
): value is BroadcastPayload<'admin_user_online_remove'> =>
    isObject(value) && hasOnlyKeys(value, REMOVE_KEYS) && isEntityId(value.id)

const PROFILE_KEYS = new Set(['name', 'preferences', 'revision'])
const PREFERENCE_KEYS = new Set(['locale', 'timeZone', 'theme', 'colorTheme', 'fontSize'])
const REVISION_PATTERN = /^(?:0|[1-9]\d*)$/

const isOneOfOrNull = (values: readonly string[], value: unknown): boolean =>
    value === null || (typeof value === 'string' && values.includes(value))

const isPreferences = (value: unknown): boolean =>
    isObject(value) &&
    hasOnlyKeys(value, PREFERENCE_KEYS) &&
    isOneOfOrNull(SHIPPED_LOCALE_CODES, value.locale) &&
    (value.timeZone === null || typeof value.timeZone === 'string') &&
    isOneOfOrNull(THEMES, value.theme) &&
    isOneOfOrNull(COLOR_THEMES, value.colorTheme) &&
    (value.fontSize === null ||
        (Number.isInteger(value.fontSize) &&
            (value.fontSize as number) >= FONT_SIZE_MIN &&
            (value.fontSize as number) <= FONT_SIZE_MAX))

/** feat-232 (Р9 B): the profile after a change, by another tab or device of the user. */
export const isUserProfileUpdatedPayload = (
    value: unknown,
): value is BroadcastPayload<'user_profile_updated'> =>
    isObject(value) &&
    hasOnlyKeys(value, PROFILE_KEYS) &&
    typeof value.name === 'string' &&
    isPreferences(value.preferences) &&
    typeof value.revision === 'string' &&
    REVISION_PATTERN.test(value.revision)

/** feat-233 (Р12): the session list changed; no data, the client reads the first page again. */
export const isUserSessionsChangedPayload = (
    value: unknown,
): value is BroadcastPayload<'user_sessions_changed'> =>
    isObject(value) && Object.keys(value).length === 0

/** feat-236 (Р8): the notifications changed; no data, the client reads the count again. */
export const isNotificationsChangedPayload = (
    value: unknown,
): value is BroadcastPayload<'notifications_changed'> =>
    isObject(value) && Object.keys(value).length === 0

/** feat-236 (Р8): the notification preferences changed; an open matrix reads them again. */
export const isNotificationPreferencesChangedPayload = (
    value: unknown,
): value is BroadcastPayload<'notification_preferences_changed'> =>
    isObject(value) && Object.keys(value).length === 0

// feat-247: `reason` tells a staff session that lost the admin channel to its MFA freshness.
const ACCESS_CHANGED_KEYS = new Set(['role', 'reason'])

/** feat-240 (Р8): the role of this connection, already applied to it on the server. */
export const isAccessChangedPayload = (
    value: unknown,
): value is BroadcastPayload<'access_changed'> =>
    isObject(value) &&
    hasOnlyKeys(value, ACCESS_CHANGED_KEYS) &&
    isRole(value.role) &&
    (value.reason === undefined || value.reason === 'mfa_session_required')

/** feat-240 (Р8): the paused admin channel may be joined again. */
export const isAdminChannelReadyPayload = (
    value: unknown,
): value is BroadcastPayload<'admin_channel_ready'> =>
    isObject(value) && Object.keys(value).length === 0

/** A guard of each broadcast event, by event (ADR 0006, decision 3, feat-182). */
export type BroadcastGuards = {
    readonly [E in BroadcastEventName]: (value: unknown) => value is BroadcastContracts[E]
}

/**
 * The guard of every broadcast event. `satisfies` makes the map complete: an event added to
 * the registry in shared/schemas/ws/broadcast-events.ts without a guard here does not compile.
 */
export const broadcastGuards = {
    support_chat_token: isSupportChatTokenPayload,
    support_chat_complete: isSupportChatCompletePayload,
    support_chat_error: isSupportChatErrorPayload,
    admin_user_online_upsert: isWSAdminUserOnlineUpsertPayload,
    admin_user_online_remove: isAdminUserOnlineRemovePayload,
    user_profile_updated: isUserProfileUpdatedPayload,
    user_sessions_changed: isUserSessionsChangedPayload,
    notifications_changed: isNotificationsChangedPayload,
    notification_preferences_changed: isNotificationPreferencesChangedPayload,
    access_changed: isAccessChangedPayload,
    admin_channel_ready: isAdminChannelReadyPayload,
} as const satisfies BroadcastGuards
