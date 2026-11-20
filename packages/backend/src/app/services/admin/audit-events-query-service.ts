import { Result } from 'better-result'
import {
    AUDIT_ACTIONS,
    auditActionsOfGroup,
    type AuditAction,
    type AuditGroup,
    type AuditTargetType,
} from 'shared/audit'
import type { AuditEvent } from 'shared/responses'

import {
    auditEventsRepository,
    userRepository,
    type AuditEventCursor,
    type AuditEventFilters,
} from '#app/repositories/index.js'
import { badRequest, type AppResult } from '#app/services/shared/errors.js'
import { auditEventTransformer } from '#app/transformers/index.js'

/** One page of the audit log (Р7). */
export const AUDIT_EVENTS_PAGE_SIZE = 50

const OCCURRED_AT_TEXT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?$/
const ID_TEXT = /^[1-9]\d{0,18}$/

/** The cursor of the next page: base64url of `occurred_at` as PostgreSQL printed it, and the id. */
export function encodeAuditCursor(cursor: AuditEventCursor): string {
    return Buffer.from(`${cursor.occurredAt}|${String(cursor.id)}`, 'utf8').toString('base64url')
}

const MAX_POSTGRES_BIGINT = 9223372036854775807n

/** Whether `text` (`YYYY-MM-DD HH:MM:SS[.ffffff]`) names a real instant, not one Date would roll over. */
function isCalendarTimestamp(text: string): boolean {
    const [date = '', time = ''] = text.split(' ')
    const [year, month, day] = date.split('-').map(Number)
    const [hours, minutes, seconds] = time.split(':').map((part) => Math.floor(Number(part)))
    if (
        year === undefined ||
        month === undefined ||
        day === undefined ||
        hours === undefined ||
        minutes === undefined ||
        seconds === undefined
    ) {
        return false
    }
    if (hours > 23 || minutes > 59 || seconds > 59) return false
    const at = new Date(Date.UTC(year, month - 1, day))
    // Date.UTC(2026, 1, 30) is March 2: a day that does not exist comes back as another one.
    return at.getUTCFullYear() === year && at.getUTCMonth() === month - 1 && at.getUTCDate() === day
}

/** The position a cursor names, or null when it is not one this service made. */
export function decodeAuditCursor(text: string): AuditEventCursor | null {
    const decoded = Buffer.from(text, 'base64url').toString('utf8')
    const [occurredAt, id, ...rest] = decoded.split('|')
    if (rest.length > 0 || occurredAt === undefined || id === undefined) return null
    if (!OCCURRED_AT_TEXT.test(occurredAt) || !ID_TEXT.test(id)) return null
    // A real timestamp and an id PostgreSQL can hold: anything else would come back as a 500.
    if (!isCalendarTimestamp(occurredAt)) return null
    const value = BigInt(id)
    if (value > MAX_POSTGRES_BIGINT) return null
    return { occurredAt, id: value }
}

export interface AuditEventsQuery {
    actions?: readonly AuditAction[]
    group?: AuditGroup
    actorUserId?: bigint
    targetUserId?: bigint
    targetType?: AuditTargetType
    targetId?: string
    requestId?: string
    from?: Date
    to?: Date
    cursor?: string
}

/** The actions a query asks for: those listed, of the group, or both at once. */
function actionsOf(query: AuditEventsQuery): readonly string[] | undefined {
    const ofGroup = query.group === undefined ? undefined : auditActionsOfGroup(query.group)
    if (query.actions === undefined) return ofGroup
    if (ofGroup === undefined) return query.actions
    return query.actions.filter((action) => AUDIT_ACTIONS[action].group === query.group)
}

export const auditEventsQueryService = {
    async list(
        query: AuditEventsQuery,
    ): Promise<AppResult<{ items: AuditEvent[]; nextCursor: string | null }>> {
        let cursor: AuditEventCursor | null = null
        if (query.cursor !== undefined) {
            cursor = decodeAuditCursor(query.cursor)
            if (cursor === null) return Result.err(badRequest('Invalid cursor', 'invalid_cursor'))
        }
        if (query.from !== undefined && query.to !== undefined && query.from >= query.to) {
            return Result.err(badRequest('`from` must be before `to`', 'invalid_range'))
        }
        const actions = actionsOf(query)
        // A group and actions of other groups: nothing can match.
        if (actions?.length === 0) {
            return Result.ok({ items: [], nextCursor: null })
        }
        const filters: AuditEventFilters = {
            ...(actions !== undefined && { actions }),
            ...(query.actorUserId !== undefined && { actorUserId: query.actorUserId }),
            ...(query.targetUserId !== undefined && { targetUserId: query.targetUserId }),
            ...(query.targetType !== undefined && { targetType: query.targetType }),
            ...(query.targetId !== undefined && { targetId: query.targetId }),
            ...(query.requestId !== undefined && { requestId: query.requestId }),
            ...(query.from !== undefined && { from: query.from }),
            ...(query.to !== undefined && { to: query.to }),
        }

        const rows = await auditEventsRepository.list(filters, cursor, AUDIT_EVENTS_PAGE_SIZE)
        const page = rows.slice(0, AUDIT_EVENTS_PAGE_SIZE)
        const last = page.at(-1)
        const nextCursor =
            rows.length > AUDIT_EVENTS_PAGE_SIZE && last !== undefined
                ? encodeAuditCursor({ occurredAt: last.occurredAt, id: last.id })
                : null

        const ids = new Set<bigint>()
        for (const row of page) {
            if (row.actorUserId !== null) ids.add(row.actorUserId)
            if (row.targetUserId !== null) ids.add(row.targetUserId)
        }
        const names = await userRepository.findNamesByIds([...ids])

        return Result.ok({
            items: page.map((row) => auditEventTransformer.serialize(row, names)),
            nextCursor,
        })
    },
}
