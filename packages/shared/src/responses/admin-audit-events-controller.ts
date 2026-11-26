import { type } from '@arktype/type'
import { EntityIdSchema } from '../brands/ids.js'
import { CursorSchema, IsoDateTimeSchema } from '../brands/wire.js'
import {
    AUDIT_ACTION_NAMES,
    AUDIT_ACTOR_KINDS,
    AUDIT_GROUPS,
    AUDIT_PROOFS,
    AUDIT_SYSTEM_SOURCES,
    AUDIT_TARGET_TYPES,
} from '../audit/audit-actions.js'
import { RoleSchema } from '../access/role-schema.js'
import { CanonicalErrorResponseSchema, type WithCanonicalError } from './error-response.js'

/**
 * Who did it (feat-235, Р6). `userId` and `name` are set for a `user` actor only; `deleted` when
 * that account no longer exists (the log keeps the id). `proof` is what allowed the change of a
 * `proof_holder` (or the one-time proof a signed-in user also gave); `source` is set for `system`.
 */
export const AuditEventActorSchema = type({
    kind: type.enumerated(...AUDIT_ACTOR_KINDS),
    userId: EntityIdSchema.or('null'),
    name: 'string | null',
    deleted: 'boolean',
    role: RoleSchema.or('null'),
    proof: type.enumerated(...AUDIT_PROOFS).or('null'),
    source: type.enumerated(...AUDIT_SYSTEM_SOURCES).or('null'),
})
export type AuditEventActor = typeof AuditEventActorSchema.infer

export const AuditEventTargetUserSchema = type({
    id: EntityIdSchema,
    name: 'string | null',
    deleted: 'boolean',
})
export type AuditEventTargetUser = typeof AuditEventTargetUserSchema.infer

const AuditValueSchema = type('string | number | boolean | null')
const AuditFromToSchema = type({ from: AuditValueSchema, to: AuditValueSchema })

/** Every key `changes` may have in the catalog (shared/audit), each `{ from, to }`. */
export const AuditChangesSchema = type({
    'role?': AuditFromToSchema,
    'title?': AuditFromToSchema,
    'category?': AuditFromToSchema,
    'isActive?': AuditFromToSchema,
    'model?': AuditFromToSchema,
    'temperature?': AuditFromToSchema,
    'maxTokens?': AuditFromToSchema,
    'topic?': AuditFromToSchema,
    'screenshot?': AuditFromToSchema,
    'content?': {
        changed: 'boolean',
        sha256Before: 'string | null',
        sha256After: 'string | null',
        charsBefore: 'number | null',
        charsAfter: 'number | null',
    },
})

/** Every key `metadata` may have in the catalog (shared/audit). */
export const AuditMetadataSchema = type({
    'source?': 'string',
    'proof?': 'string',
    'sessionsRevoked?': 'string',
    'claimed?': 'boolean',
    'passwordCleared?': 'boolean',
    'phoneRemoved?': 'boolean',
    'oauthRemoved?': 'string[]',
    'pushSubscriptionsRemoved?': 'number',
    'mfaRemoved?': 'boolean',
    // feat-245: the second factors.
    'recoveryCodesIssued?': 'boolean',
    'mfaDisabled?': 'boolean',
    'count?': 'number',
    'remaining?': 'number',
    // feat-247: the reason an administrator gave for an MFA reset.
    'reason?': 'string',
    'method?': 'string',
    'provider?': 'string',
    'mime?': 'string | null',
})

/**
 * One entry of the audit log. `changes` holds `{ from, to }` of the allowed fields (a text as its
 * hash and length), `metadata` the context of the action; both follow the catalog of the action.
 * No e-mail, phone or IP is ever part of it.
 */
export const AuditEventSchema = type({
    id: EntityIdSchema,
    occurredAt: IsoDateTimeSchema,
    action: type.enumerated(...AUDIT_ACTION_NAMES),
    group: type.enumerated(...AUDIT_GROUPS),
    actor: AuditEventActorSchema,
    target: { type: type.enumerated(...AUDIT_TARGET_TYPES), id: EntityIdSchema },
    targetUser: AuditEventTargetUserSchema.or('null'),
    requestId: 'string | null',
    changes: AuditChangesSchema.or('null'),
    metadata: AuditMetadataSchema.or('null'),
})
export type AuditEvent = typeof AuditEventSchema.infer

/** A page of the log, newest first; `nextCursor` is null on the last page. */
export const AdminAuditEventsResponseSchema = type.or(
    {
        status: "'success'",
        items: AuditEventSchema.array(),
        nextCursor: CursorSchema.or('null'),
    },
    CanonicalErrorResponseSchema,
)
export type AdminAuditEventsResponse = WithCanonicalError<
    typeof AdminAuditEventsResponseSchema.infer
>
