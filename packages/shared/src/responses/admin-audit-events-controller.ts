import { type } from '@arktype/type'
import {
    AUDIT_ACTION_NAMES,
    AUDIT_ACTOR_KINDS,
    AUDIT_GROUPS,
    AUDIT_PROOFS,
    AUDIT_SYSTEM_SOURCES,
    AUDIT_TARGET_TYPES,
} from '../audit/audit-actions.js'
import { CanonicalErrorResponseSchema, type WithCanonicalError } from './error-response.js'

/**
 * Who did it (feat-235, Р6). `userId` and `name` are set for a `user` actor only; `deleted` when
 * that account no longer exists (the log keeps the id). `proof` is what allowed the change of a
 * `proof_holder` (or the one-time proof a signed-in user also gave); `source` is set for `system`.
 */
export const AuditEventActorSchema = type({
    kind: type.enumerated(...AUDIT_ACTOR_KINDS),
    userId: 'string | null',
    name: 'string | null',
    deleted: 'boolean',
    role: "'user' | 'admin' | null",
    proof: type.enumerated(...AUDIT_PROOFS).or('null'),
    source: type.enumerated(...AUDIT_SYSTEM_SOURCES).or('null'),
})
export type AuditEventActor = typeof AuditEventActorSchema.infer

export const AuditEventTargetUserSchema = type({
    id: 'string',
    name: 'string | null',
    deleted: 'boolean',
})
export type AuditEventTargetUser = typeof AuditEventTargetUserSchema.infer

/**
 * One entry of the audit log. `changes` holds `{ from, to }` of the allowed fields (a text as its
 * hash and length), `metadata` the context of the action; both follow the catalog of the action.
 * No e-mail, phone or IP is ever part of it.
 */
export const AuditEventSchema = type({
    id: 'string',
    occurredAt: 'string',
    action: type.enumerated(...AUDIT_ACTION_NAMES),
    group: type.enumerated(...AUDIT_GROUPS),
    actor: AuditEventActorSchema,
    target: { type: type.enumerated(...AUDIT_TARGET_TYPES), id: 'string' },
    targetUser: AuditEventTargetUserSchema.or('null'),
    requestId: 'string | null',
    changes: 'Record<string, unknown> | null',
    metadata: 'Record<string, unknown> | null',
})
export type AuditEvent = typeof AuditEventSchema.infer

/** A page of the log, newest first; `nextCursor` is null on the last page. */
export const AdminAuditEventsResponseSchema = type.or(
    {
        status: "'success'",
        items: AuditEventSchema.array(),
        nextCursor: 'string | null',
    },
    CanonicalErrorResponseSchema,
)
export type AdminAuditEventsResponse = WithCanonicalError<
    typeof AdminAuditEventsResponseSchema.infer
>
