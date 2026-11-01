import type { BroadcastPayload } from 'shared/schemas'
import { ENTITY_ID_PATTERN } from 'shared/patterns'

// Hand-written guards for broadcast payloads: importing the ArkType schemas at runtime
// pulls the whole ArkType engine into the bundle (and its `new Function` JIT probe
// shows up as a CSP violation). Each guard has the contract of its schema in
// packages/shared/src/schemas/ws/broadcast-events.ts with undeclared keys rejected;
// ws-payload-guards.spec.ts checks them against the schemas.

const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)

const hasOnlyKeys = (value: Record<string, unknown>, keys: ReadonlySet<string>): boolean =>
    Object.keys(value).every((key) => keys.has(key))

const isEntityId = (value: unknown): value is string =>
    typeof value === 'string' && ENTITY_ID_PATTERN.test(value)

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
