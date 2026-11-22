import type { Role } from '../access/index.js'

// feat-235 (Р4, Р5, Р6): the closed catalog of the actions the audit log records, what each one
// may carry and how its payload is built. A payload is never a copy of a row: every projection
// below names the fields it takes, so a field added to a table later stays out of the log until
// it is named here, and the key check refuses anything else.

/** Who did it (Р6). */
export const AUDIT_ACTOR_KINDS = ['user', 'proof_holder', 'system'] as const
export type AuditActorKind = (typeof AUDIT_ACTOR_KINDS)[number]

/**
 * What allowed a change without a signed-in session of the account (`proof_holder`), or the
 * one-time proof an action of a signed-in user also required.
 */
export const AUDIT_PROOFS = [
    'email_link',
    'sms_code',
    'oauth_email_link',
    'oauth_provider_email',
    // feat-245 (docs/plan/passkeys-mfa-plan.md, Р14): the step-up proof of a sensitive action, or
    // the recovery code of a recovery session; `recent_sign_in` is a fresh OAuth sign-in of an
    // account without a password.
    'password',
    'totp',
    'passkey',
    'recovery_code',
    'recent_sign_in',
] as const
export type AuditProof = (typeof AUDIT_PROOFS)[number]

/** Where a `system` change came from. */
export const AUDIT_SYSTEM_SOURCES = ['seed', 'cli'] as const
export type AuditSystemSource = (typeof AUDIT_SYSTEM_SOURCES)[number]

export const AUDIT_GROUPS = ['rights', 'sign-in', 'sessions', 'kb', 'ai'] as const
export type AuditGroup = (typeof AUDIT_GROUPS)[number]

export const AUDIT_TARGET_TYPES = ['user', 'kb_article', 'llm_prompt'] as const
export type AuditTargetType = (typeof AUDIT_TARGET_TYPES)[number]

/**
 * The keys a payload may have: `true` is a leaf (a primitive, null, or an array of primitives), an
 * object is a nested object whose keys are listed in turn.
 */
export interface AuditShape {
    readonly [key: string]: true | AuditShape
}

const fromTo = { from: true, to: true } as const

const CONTENT_FINGERPRINT_SHAPE = {
    changed: true,
    sha256Before: true,
    sha256After: true,
    charsBefore: true,
    charsAfter: true,
} as const

const ARTICLE_CHANGES_SHAPE = {
    title: fromTo,
    category: fromTo,
    isActive: fromTo,
    content: CONTENT_FINGERPRINT_SHAPE,
} as const

const PROMPT_CHANGES_SHAPE = {
    model: fromTo,
    temperature: fromTo,
    maxTokens: fromTo,
    topic: fromTo,
    content: CONTENT_FINGERPRINT_SHAPE,
} as const

const SCREENSHOT_CHANGES_SHAPE = { screenshot: fromTo } as const

interface AuditActionDefinition {
    readonly group: AuditGroup
    readonly targetType: AuditTargetType
    readonly actorKinds: readonly AuditActorKind[]
    /**
     * The proofs the actor may carry (Р6): non-empty means one of them is required, empty means
     * the action takes none.
     */
    readonly proofs: readonly AuditProof[]
    readonly changes: AuditShape | null
    readonly metadata: AuditShape | null
}

export const AUDIT_ACTIONS = {
    'user.admin.created': {
        group: 'rights',
        targetType: 'user',
        actorKinds: ['system'],
        proofs: [],
        changes: { role: fromTo },
        metadata: { source: true },
    },
    // feat-240 (Р7): a role changed by an admin (HTTP) or by the user:set-role CLI.
    'user.role.changed': {
        group: 'rights',
        targetType: 'user',
        actorKinds: ['user', 'system'],
        proofs: [],
        changes: { role: fromTo },
        metadata: { source: true },
    },
    'auth.password.changed': {
        group: 'sign-in',
        targetType: 'user',
        actorKinds: ['user'],
        proofs: [],
        changes: null,
        metadata: { sessionsRevoked: true },
    },
    'auth.password.reset': {
        group: 'sign-in',
        targetType: 'user',
        actorKinds: ['proof_holder'],
        proofs: ['email_link', 'sms_code'],
        changes: null,
        metadata: { proof: true, claimed: true },
    },
    'auth.account.claimed': {
        group: 'sign-in',
        targetType: 'user',
        actorKinds: ['proof_holder'],
        proofs: ['email_link', 'oauth_email_link', 'oauth_provider_email'],
        changes: null,
        metadata: {
            proof: true,
            passwordCleared: true,
            phoneRemoved: true,
            oauthRemoved: true,
            pushSubscriptionsRemoved: true,
            mfaRemoved: true,
        },
    },
    'auth.phone.linked': {
        group: 'sign-in',
        targetType: 'user',
        actorKinds: ['user'],
        proofs: ['sms_code'],
        changes: null,
        metadata: { method: true, proof: true },
    },
    'auth.email.linked': {
        group: 'sign-in',
        targetType: 'user',
        actorKinds: ['user'],
        proofs: ['email_link'],
        changes: null,
        metadata: { method: true, proof: true },
    },
    'auth.oauth.linked': {
        group: 'sign-in',
        targetType: 'user',
        actorKinds: ['proof_holder'],
        proofs: ['oauth_email_link', 'oauth_provider_email'],
        changes: null,
        metadata: { method: true, provider: true, proof: true },
    },
    'auth.sign_in_method.unlinked': {
        group: 'sign-in',
        targetType: 'user',
        actorKinds: ['user'],
        proofs: [],
        changes: null,
        metadata: { method: true, provider: true },
    },
    'auth.sessions.revoked_all': {
        group: 'sessions',
        targetType: 'user',
        actorKinds: ['user'],
        proofs: [],
        changes: null,
        metadata: null,
    },
    'auth.sessions.revoked_others': {
        group: 'sessions',
        targetType: 'user',
        actorKinds: ['user'],
        proofs: [],
        changes: null,
        metadata: null,
    },
    // feat-245 (Р14): the second factors and the recovery codes of an account.
    'auth.mfa.totp.enabled': {
        group: 'sign-in',
        targetType: 'user',
        actorKinds: ['user'],
        proofs: ['password', 'totp', 'passkey', 'recovery_code', 'recent_sign_in'],
        changes: null,
        metadata: { proof: true, recoveryCodesIssued: true },
    },
    'auth.mfa.totp.replaced': {
        group: 'sign-in',
        targetType: 'user',
        actorKinds: ['user'],
        proofs: ['totp', 'passkey', 'recovery_code'],
        changes: null,
        metadata: { proof: true },
    },
    'auth.mfa.totp.disabled': {
        group: 'sign-in',
        targetType: 'user',
        actorKinds: ['user'],
        proofs: ['totp', 'passkey', 'recovery_code'],
        changes: null,
        metadata: { proof: true, mfaDisabled: true },
    },
    'auth.mfa.recovery_codes.regenerated': {
        group: 'sign-in',
        targetType: 'user',
        actorKinds: ['user'],
        proofs: ['totp', 'passkey', 'recovery_code'],
        changes: null,
        metadata: { proof: true, count: true },
    },
    'auth.mfa.recovery_code.used': {
        group: 'sign-in',
        targetType: 'user',
        actorKinds: ['proof_holder'],
        proofs: ['recovery_code'],
        changes: null,
        metadata: { proof: true, remaining: true },
    },
    'kb.article.created': {
        group: 'kb',
        targetType: 'kb_article',
        actorKinds: ['user'],
        proofs: [],
        changes: ARTICLE_CHANGES_SHAPE,
        metadata: null,
    },
    'kb.article.updated': {
        group: 'kb',
        targetType: 'kb_article',
        actorKinds: ['user'],
        proofs: [],
        changes: ARTICLE_CHANGES_SHAPE,
        metadata: null,
    },
    'kb.article.deleted': {
        group: 'kb',
        targetType: 'kb_article',
        actorKinds: ['user'],
        proofs: [],
        changes: ARTICLE_CHANGES_SHAPE,
        metadata: null,
    },
    'kb.screenshot.uploaded': {
        group: 'kb',
        targetType: 'kb_article',
        actorKinds: ['user'],
        proofs: [],
        changes: SCREENSHOT_CHANGES_SHAPE,
        metadata: { mime: true },
    },
    'kb.screenshot.removed': {
        group: 'kb',
        targetType: 'kb_article',
        actorKinds: ['user'],
        proofs: [],
        changes: SCREENSHOT_CHANGES_SHAPE,
        metadata: { mime: true },
    },
    'ai.prompt.updated': {
        group: 'ai',
        targetType: 'llm_prompt',
        actorKinds: ['user'],
        proofs: [],
        changes: PROMPT_CHANGES_SHAPE,
        metadata: null,
    },
} as const satisfies Record<string, AuditActionDefinition>

export type AuditAction = keyof typeof AUDIT_ACTIONS
export const AUDIT_ACTION_NAMES = Object.keys(AUDIT_ACTIONS) as AuditAction[]

/** Every action of a group, in catalog order. */
export function auditActionsOfGroup(group: AuditGroup): AuditAction[] {
    return AUDIT_ACTION_NAMES.filter((action) => AUDIT_ACTIONS[action].group === group)
}

export function isAuditAction(value: string): value is AuditAction {
    return Object.hasOwn(AUDIT_ACTIONS, value)
}

/** The largest serialized `{ changes, metadata }` the log stores, in UTF-8 bytes (Р5). */
export const AUDIT_PAYLOAD_MAX_BYTES = 8192

// ─── payload types ──────────────────────────────────────────────────────────────────────────

export interface AuditFromTo<T> {
    from: T
    to: T
}

/**
 * A text never goes into the log: only whether it changed, its SHA-256 (hex) and its length in
 * characters before and after. `null` on the side where there was no text (a created or a
 * deleted article). The hash is computed by the backend.
 */
export interface AuditContentFingerprint {
    changed: boolean
    sha256Before: string | null
    sha256After: string | null
    charsBefore: number | null
    charsAfter: number | null
}

export interface AuditArticleFields {
    title: string
    category: string | null
    isActive: boolean
}

export interface AuditArticleChanges {
    title?: AuditFromTo<string | null>
    category?: AuditFromTo<string | null>
    isActive?: AuditFromTo<boolean | null>
    content?: AuditContentFingerprint
}

export interface AuditPromptFields {
    model: string | null
    temperature: number | null
    maxTokens: number | null
    topic: string | null
}

export interface AuditPromptChanges {
    model?: AuditFromTo<string | null>
    temperature?: AuditFromTo<number | null>
    maxTokens?: AuditFromTo<number | null>
    topic?: AuditFromTo<string | null>
    content?: AuditContentFingerprint
}

/** What the caller of each action hands over; the projection takes only the named fields. */
export interface AuditInputs {
    'user.admin.created': Record<string, never>
    'user.role.changed': { from: Role; to: Role }
    'auth.password.changed': Record<string, never>
    'auth.password.reset': { claimed: boolean }
    'auth.account.claimed': {
        passwordCleared: boolean
        phoneRemoved: boolean
        oauthRemoved: readonly string[]
        pushSubscriptionsRemoved: number
        /** feat-245: a second factor or recovery codes were removed. */
        mfaRemoved: boolean
    }
    'auth.phone.linked': Record<string, never>
    'auth.email.linked': Record<string, never>
    'auth.oauth.linked': { provider: string }
    'auth.sign_in_method.unlinked': { method: 'oauth'; provider: string }
    'auth.sessions.revoked_all': Record<string, never>
    'auth.sessions.revoked_others': Record<string, never>
    'auth.mfa.totp.enabled': { recoveryCodesIssued: boolean }
    'auth.mfa.totp.replaced': Record<string, never>
    'auth.mfa.totp.disabled': { mfaDisabled: boolean }
    'auth.mfa.recovery_codes.regenerated': { count: number }
    'auth.mfa.recovery_code.used': { remaining: number }
    'kb.article.created': { after: AuditArticleFields; content: AuditContentFingerprint }
    'kb.article.updated': {
        before: AuditArticleFields
        after: AuditArticleFields
        content: AuditContentFingerprint
    }
    'kb.article.deleted': { before: AuditArticleFields; content: AuditContentFingerprint }
    'kb.screenshot.uploaded': { hadScreenshot: boolean; mime: string }
    'kb.screenshot.removed': { hadScreenshot: boolean; mime: string | null }
    'ai.prompt.updated': {
        before: AuditPromptFields
        after: AuditPromptFields
        content: AuditContentFingerprint
    }
}

export type AuditJson = string | number | boolean | null | readonly AuditJson[] | AuditJsonObject
export interface AuditJsonObject {
    readonly [key: string]: AuditJson
}

export interface AuditPayload {
    changes: AuditJsonObject | null
    metadata: AuditJsonObject | null
}

/** What the actor adds to `metadata`: its proof, or the source of a system change (Р6). */
export interface AuditActorMetadata {
    proof?: AuditProof | null
    source?: AuditSystemSource | null
}

// ─── projections ────────────────────────────────────────────────────────────────────────────

/** The fields of `fields` whose value differs between the two, as `{ from, to }`; null if none. */
export function diffAllowed<T extends object, K extends keyof T & string>(
    before: T | null,
    after: T | null,
    fields: readonly K[],
): { [P in K]?: AuditFromTo<T[P] | null> } | null {
    const out: { [P in K]?: AuditFromTo<T[P] | null> } = {}
    let changed = false
    for (const field of fields) {
        const from = before === null ? null : before[field]
        const to = after === null ? null : after[field]
        if (!Object.is(from, to)) {
            out[field] = { from, to }
            changed = true
        }
    }
    return changed ? out : null
}

const ARTICLE_FIELDS = ['title', 'category', 'isActive'] as const
const PROMPT_FIELDS = ['model', 'temperature', 'maxTokens', 'topic'] as const

const fingerprint = (content: AuditContentFingerprint): AuditContentFingerprint => ({
    changed: content.changed,
    sha256Before: content.sha256Before,
    sha256After: content.sha256After,
    charsBefore: content.charsBefore,
    charsAfter: content.charsAfter,
})

// Built field by field: a row passed in by mistake contributes nothing but the named fields.
const articleFields = (row: AuditArticleFields): AuditArticleFields => ({
    title: row.title,
    category: row.category,
    isActive: row.isActive,
})

const promptFields = (row: AuditPromptFields): AuditPromptFields => ({
    model: row.model,
    temperature: row.temperature,
    maxTokens: row.maxTokens,
    topic: row.topic,
})

const articleChanges = (
    before: AuditArticleFields | null,
    after: AuditArticleFields | null,
    content: AuditContentFingerprint,
): AuditJsonObject | null => {
    const diff = diffAllowed(
        before === null ? null : articleFields(before),
        after === null ? null : articleFields(after),
        ARTICLE_FIELDS,
    )
    const changes: AuditArticleChanges = { ...diff }
    if (content.changed) changes.content = fingerprint(content)
    return Object.keys(changes).length === 0 ? null : (changes as AuditJsonObject)
}

const none = (): AuditPayload => ({ changes: null, metadata: null })

type Projections = { [A in AuditAction]: (input: AuditInputs[A]) => AuditPayload }

const PROJECTIONS: Projections = {
    'user.admin.created': () => ({
        changes: { role: { from: null, to: 'admin' } },
        metadata: null,
    }),
    'user.role.changed': (input) => ({
        changes: { role: { from: input.from, to: input.to } },
        metadata: null,
    }),
    'auth.password.changed': () => ({ changes: null, metadata: { sessionsRevoked: 'others' } }),
    'auth.password.reset': (input) => ({ changes: null, metadata: { claimed: input.claimed } }),
    'auth.account.claimed': (input) => ({
        changes: null,
        metadata: {
            passwordCleared: input.passwordCleared,
            phoneRemoved: input.phoneRemoved,
            // Distinct names: an account may hold several links of one provider.
            oauthRemoved: [...new Set(input.oauthRemoved.map(String))].sort(),
            pushSubscriptionsRemoved: input.pushSubscriptionsRemoved,
            mfaRemoved: input.mfaRemoved,
        },
    }),
    'auth.phone.linked': () => ({ changes: null, metadata: { method: 'phone' } }),
    'auth.email.linked': () => ({ changes: null, metadata: { method: 'email' } }),
    'auth.oauth.linked': (input) => ({
        changes: null,
        metadata: { method: 'oauth', provider: input.provider },
    }),
    'auth.sign_in_method.unlinked': (input) => ({
        changes: null,
        metadata: { method: input.method, provider: input.provider },
    }),
    'auth.sessions.revoked_all': none,
    'auth.sessions.revoked_others': none,
    'auth.mfa.totp.enabled': (input) => ({
        changes: null,
        metadata: { recoveryCodesIssued: input.recoveryCodesIssued },
    }),
    'auth.mfa.totp.replaced': none,
    'auth.mfa.totp.disabled': (input) => ({
        changes: null,
        metadata: { mfaDisabled: input.mfaDisabled },
    }),
    'auth.mfa.recovery_codes.regenerated': (input) => ({
        changes: null,
        metadata: { count: input.count },
    }),
    'auth.mfa.recovery_code.used': (input) => ({
        changes: null,
        metadata: { remaining: input.remaining },
    }),
    'kb.article.created': (input) => ({
        changes: articleChanges(null, input.after, input.content),
        metadata: null,
    }),
    'kb.article.updated': (input) => ({
        changes: articleChanges(input.before, input.after, input.content),
        metadata: null,
    }),
    'kb.article.deleted': (input) => ({
        changes: articleChanges(input.before, null, input.content),
        metadata: null,
    }),
    'kb.screenshot.uploaded': (input) => ({
        changes: { screenshot: { from: input.hadScreenshot, to: true } },
        metadata: { mime: input.mime },
    }),
    'kb.screenshot.removed': (input) => ({
        changes: { screenshot: { from: input.hadScreenshot, to: false } },
        metadata: { mime: input.mime },
    }),
    'ai.prompt.updated': (input) => {
        const diff = diffAllowed(
            promptFields(input.before),
            promptFields(input.after),
            PROMPT_FIELDS,
        )
        const changes: AuditPromptChanges = { ...diff }
        if (input.content.changed) changes.content = fingerprint(input.content)
        return {
            changes: Object.keys(changes).length === 0 ? null : (changes as AuditJsonObject),
            metadata: null,
        }
    },
}

// ─── key check ──────────────────────────────────────────────────────────────────────────────

export class AuditPayloadError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'AuditPayloadError'
    }
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)

const isLeaf = (value: unknown): boolean => {
    if (value === null) return true
    if (Array.isArray(value)) return value.every((item) => item === null || isPrimitive(item))
    return isPrimitive(value)
}

const isPrimitive = (value: unknown): boolean =>
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))

function checkShape(value: unknown, shape: AuditShape, path: string): void {
    if (!isPlainObject(value)) {
        throw new AuditPayloadError(`audit payload: ${path} must be an object`)
    }
    for (const [key, child] of Object.entries(value)) {
        const allowed = Object.hasOwn(shape, key) ? shape[key] : undefined
        if (allowed === undefined) {
            throw new AuditPayloadError(`audit payload: key ${path}.${key} is not allowed`)
        }
        if (allowed === true) {
            if (!isLeaf(child)) {
                throw new AuditPayloadError(`audit payload: ${path}.${key} must be a plain value`)
            }
        } else if (child !== null) {
            checkShape(child, allowed, `${path}.${key}`)
        }
    }
}

/**
 * Throws unless every key of `changes` and `metadata`, at every depth, is one the action lists.
 * Leaves must be primitives, null, or arrays of those.
 */
export function assertAuditKeys(action: AuditAction, payload: AuditPayload): void {
    const definition: AuditActionDefinition = AUDIT_ACTIONS[action]
    for (const part of ['changes', 'metadata'] as const) {
        const value = payload[part]
        if (value === null) continue
        const shape = definition[part]
        if (shape === null) {
            throw new AuditPayloadError(`audit payload: ${action} has no ${part}`)
        }
        checkShape(value, shape, part)
    }
}

/**
 * The payload of one event (Р5): the projection of the action, the actor's proof or source added
 * to `metadata`, and the key check. The byte size is checked by the backend before the insert.
 */
export function buildAuditPayload<A extends AuditAction>(
    action: A,
    input: AuditInputs[A],
    actor: AuditActorMetadata = {},
): AuditPayload {
    const projected = (PROJECTIONS[action] as (input: AuditInputs[A]) => AuditPayload)(input)
    let metadata: Record<string, AuditJson> | null =
        projected.metadata === null ? null : { ...projected.metadata }
    if (actor.proof !== undefined && actor.proof !== null) {
        metadata = { ...metadata, proof: actor.proof }
    }
    if (actor.source !== undefined && actor.source !== null) {
        metadata = { ...metadata, source: actor.source }
    }
    const payload: AuditPayload = { changes: projected.changes, metadata }
    assertAuditKeys(action, payload)
    return payload
}
