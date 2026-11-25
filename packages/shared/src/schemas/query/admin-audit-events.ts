import { type } from '@arktype/type'
import { AUDIT_ACTION_NAMES, AUDIT_GROUPS, AUDIT_TARGET_TYPES } from '../../audit/audit-actions.js'
import { EntityIdStringSchema } from '../../brands/ids.js'
import type { QueryInputOf } from './types.js'

/** Longest `cursor` the audit-log list accepts; its form is checked by the backend (Р7). */
export const AUDIT_CURSOR_MAX_LENGTH = 128

/** Most `action` values one request may filter by: every action of the catalog. */
export const AUDIT_ACTION_FILTER_MAX = AUDIT_ACTION_NAMES.length

/** The query key that repeats: `?action=a&action=b`. */
export const AUDIT_EVENTS_QUERY_ARRAYS = ['action'] as const

// feat-235 (Р7): the filters of GET /admin/audit-events. `from` and `to` are ISO 8601 with up to
// millisecond precision: `occurred_at >= from` and `occurred_at < to`.
export const AdminAuditEventsQuerySchema = type({
    'action?': type
        .enumerated(...AUDIT_ACTION_NAMES)
        .array()
        .atLeastLength(1)
        .atMostLength(AUDIT_ACTION_FILTER_MAX),
    'group?': type.enumerated(...AUDIT_GROUPS),
    'actorUserId?': EntityIdStringSchema,
    'targetUserId?': EntityIdStringSchema,
    'targetType?': type.enumerated(...AUDIT_TARGET_TYPES),
    'targetId?': '1 <= string <= 64',
    'requestId?': 'string.uuid',
    'from?': 'string.date.iso.parse',
    'to?': 'string.date.iso.parse',
    'cursor?': /^[\w-]{1,128}$/,
    '+': 'reject',
})

export type AdminAuditEventsQuery = typeof AdminAuditEventsQuerySchema.infer
export type AdminAuditEventsQueryInput = QueryInputOf<typeof AdminAuditEventsQuerySchema>
