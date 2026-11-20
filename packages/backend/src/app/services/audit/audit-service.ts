import {
    AUDIT_ACTIONS,
    AUDIT_PAYLOAD_MAX_BYTES,
    AuditPayloadError,
    buildAuditPayload,
    type AuditAction,
    type AuditInputs,
    type AuditPayload,
    type AuditTargetType,
} from 'shared/audit'

import {
    auditEventsRepository,
    readClockTimestamp,
    type AuditEventInsert,
    type DbTransaction,
} from '#app/repositories/index.js'
import type { AuditActor, AuditLogger } from './audit-actor.js'

declare const stampBrand: unique symbol

/**
 * The moment of a change (Р3): `clock_timestamp()` read in its transaction after the statement
 * that took the row lock. Only `auditService.stamp` makes one, so an event cannot be written with
 * a time taken anywhere else.
 */
export interface AuditStamp {
    readonly occurredAt: string
    readonly [stampBrand]: true
}

/** One event of a change: the action, its target and what the projection of the action takes. */
export type AuditEventInput = {
    [A in AuditAction]: {
        action: A
        targetId: string
        /** Whose account the change concerns; for a `user` target it is the target itself. */
        targetUserId?: bigint | null
        input: AuditInputs[A]
    }
}[AuditAction]

/** What was written, for the log line after the commit (Р12). */
export interface RecordedAuditEvent {
    action: AuditAction
    targetType: AuditTargetType
    targetId: string
}

/** Throws when the serialized `{ changes, metadata }` is larger than the bound (Р5). */
export function assertAuditPayloadSize(payload: AuditPayload): void {
    const bytes = Buffer.byteLength(JSON.stringify(payload), 'utf8')
    if (bytes > AUDIT_PAYLOAD_MAX_BYTES) {
        throw new AuditPayloadError(
            `audit payload: ${String(bytes)} bytes, more than ${String(AUDIT_PAYLOAD_MAX_BYTES)}`,
        )
    }
}

function assertActor(action: AuditAction, actor: AuditActor): void {
    const definition = AUDIT_ACTIONS[action]
    const allowed: readonly string[] = definition.actorKinds
    if (!allowed.includes(actor.kind)) {
        throw new AuditPayloadError(`audit: ${action} cannot be done by a ${actor.kind} actor`)
    }
    // The types say so already; this holds for a caller that went around them (Р6).
    if (actor.kind !== 'system' && (actor.requestId as string | null) == null) {
        throw new AuditPayloadError(`audit: ${action} by a ${actor.kind} needs its request id`)
    }
    const proofs: readonly string[] = definition.proofs
    const proof = actor.proof as string | null
    if (proofs.length === 0) {
        if (proof != null) {
            throw new AuditPayloadError(`audit: ${action} takes no proof, got ${proof}`)
        }
    } else if (proof == null || !proofs.includes(proof)) {
        throw new AuditPayloadError(
            `audit: ${action} needs one of the proofs ${proofs.join(', ')}, got ${String(proof)}`,
        )
    }
}

export const auditService = {
    /** Call right after the statement that locks the changed row, in the same transaction. */
    async stamp(tx: DbTransaction): Promise<AuditStamp> {
        return { occurredAt: await readClockTimestamp(tx) } as AuditStamp
    },

    /**
     * Writes the events of one change in its transaction (fail closed): any check that fails
     * throws, and the change rolls back with it. Call only on the branch where the change
     * happened.
     */
    async record(
        tx: DbTransaction,
        stamp: AuditStamp,
        actor: AuditActor,
        events: readonly AuditEventInput[],
    ): Promise<RecordedAuditEvent[]> {
        const rows: AuditEventInsert[] = []
        const recorded: RecordedAuditEvent[] = []
        for (const event of events) {
            assertActor(event.action, actor)
            const payload = buildAuditPayload(event.action, event.input as never, {
                proof: actor.proof,
                source: actor.source,
            })
            assertAuditPayloadSize(payload)
            const targetType = AUDIT_ACTIONS[event.action].targetType
            rows.push({
                occurredAt: stamp.occurredAt,
                actorKind: actor.kind,
                actorUserId: actor.userId,
                actorRole: actor.role,
                action: event.action,
                targetType,
                targetId: event.targetId,
                targetUserId: event.targetUserId ?? null,
                requestId: actor.requestId,
                changes: payload.changes,
                metadata: payload.metadata,
            })
            recorded.push({ action: event.action, targetType, targetId: event.targetId })
        }
        await auditEventsRepository.insert(rows, tx)
        return recorded
    },

    /**
     * One log line per event, after the commit (Р12): the request logger carries the request id,
     * so an event is found in the logs by it too. No `changes`.
     */
    logCommitted(log: AuditLogger, events: readonly RecordedAuditEvent[]): void {
        for (const event of events) {
            log.info(
                {
                    audit: {
                        action: event.action,
                        targetType: event.targetType,
                        targetId: event.targetId,
                    },
                },
                'audit event',
            )
        }
    },
}
