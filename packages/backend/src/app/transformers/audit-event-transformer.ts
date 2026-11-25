import { AUDIT_ACTIONS, isAuditAction, type AuditProof, type AuditSystemSource } from 'shared/audit'
import { toEntityId } from '#app/domain/ids.js'
import type { AuditEvent } from 'shared/responses'

import type { AuditEventListRow } from '#app/repositories/index.js'

/** `occurred_at` as PostgreSQL printed it (UTC, no zone) in ISO 8601, microseconds kept. */
export const occurredAtIso = (text: string): string => `${text.replace(' ', 'T')}Z`

const asRecord = (value: unknown): Record<string, unknown> | null =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null

// feat-235 (Р7): an entry as an admin sees it. The names come from one read of `users` for the
// page; an account deleted since is shown by id with `deleted`. No e-mail.
export const auditEventTransformer = {
    serialize(row: AuditEventListRow, names: ReadonlyMap<string, string>): AuditEvent {
        if (!isAuditAction(row.action)) {
            // Only the catalog is ever written; a row outside it is a bug, not data to show.
            throw new Error(`audit_events row ${String(row.id)} has an unknown action`)
        }
        const metadata = asRecord(row.metadata)
        const actorId = row.actorUserId === null ? null : toEntityId(row.actorUserId)
        const targetUserId = row.targetUserId === null ? null : toEntityId(row.targetUserId)
        const proof = metadata?.['proof']
        const source = metadata?.['source']
        return {
            id: String(row.id),
            occurredAt: occurredAtIso(row.occurredAt),
            action: row.action,
            group: AUDIT_ACTIONS[row.action].group,
            actor: {
                kind: row.actorKind,
                userId: actorId,
                name: actorId === null ? null : (names.get(actorId) ?? null),
                deleted: actorId !== null && !names.has(actorId),
                role: row.actorRole,
                proof: typeof proof === 'string' ? (proof as AuditProof) : null,
                source:
                    row.actorKind === 'system' && typeof source === 'string'
                        ? (source as AuditSystemSource)
                        : null,
            },
            target: { type: AUDIT_ACTIONS[row.action].targetType, id: row.targetId },
            targetUser:
                targetUserId === null
                    ? null
                    : {
                          id: targetUserId,
                          name: names.get(targetUserId) ?? null,
                          deleted: !names.has(targetUserId),
                      },
            requestId: row.requestId,
            changes: asRecord(row.changes),
            metadata: metadata,
        }
    },
}
