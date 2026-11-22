import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
    AUDIT_ACTIONS,
    AUDIT_ACTION_NAMES,
    AUDIT_PAYLOAD_MAX_BYTES,
    AuditPayloadError,
    assertAuditKeys,
    auditActionsOfGroup,
    buildAuditPayload,
    diffAllowed,
} from '../dist/audit/index.js'
import { AdminAuditEventsQuerySchema } from '../dist/schemas/index.js'
import { AdminAuditEventsResponseSchema } from '../dist/responses/index.js'

const isError = (result) => result !== null && typeof result === 'object' && 'summary' in result

// feat-235 (Р4, Р5): what never goes into the log, whatever a caller hands over.
const SECRETS = {
    password: 'hunter2-hash',
    sessionToken: 'session-token-secret',
    providerEmail: 'someone@example.com',
    providerUserId: 'provider-user-1',
    screenshotKey: 'knowledge-base/1/secret.png',
    email: 'someone@example.com',
    phone: '+380501234567',
}

const fingerprint = {
    changed: true,
    sha256Before: 'a'.repeat(64),
    sha256After: 'b'.repeat(64),
    charsBefore: 10,
    charsAfter: 12,
}

const article = (title) => ({ title, category: 'billing', isActive: true })
const prompt = (model) => ({ model, temperature: 0.2, maxTokens: 100, topic: null })

// One valid input per action; each test below adds the secrets on every level it can reach.
const INPUTS = {
    'user.admin.created': {},
    'user.role.changed': { from: 'user', to: 'kb_editor' },
    'auth.password.changed': {},
    'auth.password.reset': { claimed: true },
    'auth.account.claimed': {
        passwordCleared: true,
        phoneRemoved: true,
        oauthRemoved: ['google', 'github'],
        pushSubscriptionsRemoved: 2,
        mfaRemoved: true,
    },
    'auth.phone.linked': {},
    'auth.email.linked': {},
    'auth.oauth.linked': { provider: 'google' },
    'auth.sign_in_method.unlinked': { method: 'oauth', provider: 'google' },
    'auth.sessions.revoked_all': {},
    'auth.sessions.revoked_others': {},
    'auth.mfa.totp.enabled': { recoveryCodesIssued: true },
    'auth.mfa.totp.replaced': {},
    'auth.mfa.totp.disabled': { mfaDisabled: false },
    'auth.mfa.recovery_codes.regenerated': { count: 10 },
    'auth.mfa.recovery_code.used': { remaining: 9 },
    'kb.article.created': { after: article('New'), content: fingerprint },
    'kb.article.updated': { before: article('Old'), after: article('New'), content: fingerprint },
    'kb.article.deleted': { before: article('Old'), content: fingerprint },
    'kb.screenshot.uploaded': { hadScreenshot: false, mime: 'image/png' },
    'kb.screenshot.removed': { hadScreenshot: true, mime: 'image/png' },
    'ai.prompt.updated': { before: prompt('a'), after: prompt('b'), content: fingerprint },
}

const ACTORS = {
    user: {},
    proof_holder: { proof: 'email_link' },
    system: { source: 'seed' },
}

const withSecrets = (value) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
    const out = { ...SECRETS }
    for (const [key, child] of Object.entries(value)) out[key] = withSecrets(child)
    return out
}

test('the catalog: 16 actions of the first release, user.role.changed, 5 MFA actions (feat-245)', () => {
    assert.equal(AUDIT_ACTION_NAMES.length, 22)
    assert.ok(AUDIT_ACTION_NAMES.includes('user.role.changed'))
    assert.deepEqual(Object.keys(INPUTS).sort(), [...AUDIT_ACTION_NAMES].sort())
})

test('every action has a group, a target type and at least one actor kind', () => {
    for (const action of AUDIT_ACTION_NAMES) {
        const definition = AUDIT_ACTIONS[action]
        assert.ok(definition.group, action)
        assert.ok(definition.targetType, action)
        assert.ok(definition.actorKinds.length > 0, action)
    }
    assert.deepEqual(auditActionsOfGroup('sessions'), [
        'auth.sessions.revoked_all',
        'auth.sessions.revoked_others',
    ])
})

for (const action of AUDIT_ACTION_NAMES) {
    test(`${action}: the projection keeps no field it does not name`, () => {
        const definition = AUDIT_ACTIONS[action]
        const kind = definition.actorKinds[0]
        // An action that requires a proof gets the first one it lists.
        const actor =
            definition.proofs.length > 0 && kind !== 'system'
                ? { ...ACTORS[kind], proof: definition.proofs[0] }
                : ACTORS[kind]
        const payload = buildAuditPayload(action, withSecrets(INPUTS[action]), actor)
        const json = JSON.stringify(payload)
        const keys = []
        JSON.parse(json, (key, value) => {
            keys.push(key)
            return value
        })
        for (const [key, value] of Object.entries(SECRETS)) {
            assert.ok(!keys.includes(key), `${action}: key ${key} in ${json}`)
            assert.ok(!json.includes(value), `${action}: value of ${key} in ${json}`)
        }
        // And the result passes its own key check.
        assertAuditKeys(action, payload)
    })
}

test('an unknown key in changes or metadata is refused', () => {
    assert.throws(
        () =>
            assertAuditKeys('kb.article.updated', {
                changes: { title: { from: 'a', to: 'b' }, password: 'x' },
                metadata: null,
            }),
        AuditPayloadError,
    )
    assert.throws(
        () =>
            assertAuditKeys('kb.article.updated', {
                changes: { title: { from: 'a', to: 'b', password: 'x' } },
                metadata: null,
            }),
        AuditPayloadError,
    )
    assert.throws(
        () =>
            assertAuditKeys('auth.oauth.linked', {
                changes: null,
                metadata: { method: 'oauth', provider: 'google', providerEmail: 'x@example.com' },
            }),
        AuditPayloadError,
    )
    // An action without metadata takes none at all.
    assert.throws(
        () =>
            assertAuditKeys('auth.sessions.revoked_all', {
                changes: null,
                metadata: { anything: 1 },
            }),
        AuditPayloadError,
    )
    // A leaf cannot carry an object that would smuggle keys past the check.
    assert.throws(
        () =>
            assertAuditKeys('auth.oauth.linked', {
                changes: null,
                metadata: { provider: { password: 'x' } },
            }),
        AuditPayloadError,
    )
    // A proof on an action that takes none is refused too.
    assert.throws(
        () => buildAuditPayload('auth.sessions.revoked_all', {}, { proof: 'sms_code' }),
        AuditPayloadError,
    )
})

test('the actor adds its proof or source to metadata', () => {
    assert.deepEqual(
        buildAuditPayload('auth.password.reset', { claimed: false }, { proof: 'sms_code' }),
        { changes: null, metadata: { claimed: false, proof: 'sms_code' } },
    )
    assert.deepEqual(buildAuditPayload('user.admin.created', {}, { source: 'seed' }), {
        changes: { role: { from: null, to: 'admin' } },
        metadata: { source: 'seed' },
    })
})

test('diffAllowed: only the changed fields, null when none', () => {
    assert.equal(diffAllowed({ a: 1, b: 'x' }, { a: 1, b: 'x' }, ['a', 'b']), null)
    assert.deepEqual(diffAllowed({ a: 1, b: 'x' }, { a: 2, b: 'x' }, ['a', 'b']), {
        a: { from: 1, to: 2 },
    })
    assert.deepEqual(diffAllowed({ a: null }, { a: 'v' }, ['a']), { a: { from: null, to: 'v' } })
    assert.deepEqual(diffAllowed({ a: 'v' }, { a: null }, ['a']), { a: { from: 'v', to: null } })
    assert.deepEqual(diffAllowed({ a: true }, { a: false }, ['a']), {
        a: { from: true, to: false },
    })
    assert.equal(diffAllowed({ a: false }, { a: false }, ['a']), null)
    // A field not listed is never compared.
    assert.equal(diffAllowed({ a: 1, secret: 'x' }, { a: 1, secret: 'y' }, ['a']), null)
    // No row on one side: every field is a change from or to null.
    assert.deepEqual(diffAllowed(null, { a: 1 }, ['a']), { a: { from: null, to: 1 } })
})

test('an update without any change has no changes', () => {
    const same = article('Same')
    const unchanged = { ...fingerprint, changed: false }
    assert.deepEqual(
        buildAuditPayload('kb.article.updated', { before: same, after: same, content: unchanged }),
        { changes: null, metadata: null },
    )
    // A content change alone carries only the fingerprint.
    assert.deepEqual(
        buildAuditPayload('kb.article.updated', { before: same, after: same, content: fingerprint })
            .changes,
        { content: fingerprint },
    )
})

test('the payload bound is 8192 bytes', () => {
    assert.equal(AUDIT_PAYLOAD_MAX_BYTES, 8192)
})

test('the query schema checks every filter and refuses unknown keys', () => {
    const ok = AdminAuditEventsQuerySchema({
        action: ['kb.article.updated', 'ai.prompt.updated'],
        group: 'kb',
        actorUserId: '1',
        targetUserId: '2',
        targetType: 'kb_article',
        targetId: '5',
        requestId: '0f8fad5b-d9cb-469f-a165-70867728950e',
        from: '2026-11-20T10:00:00.123Z',
        to: '2026-11-21T00:00:00Z',
        cursor: 'abc_-1',
    })
    assert.ok(!isError(ok), String(ok.summary ?? ''))
    assert.ok(ok.from instanceof Date)
    assert.equal(ok.from.toISOString(), '2026-11-20T10:00:00.123Z')

    for (const bad of [
        { action: ['kb.article.unknown'] },
        { action: [] },
        { group: 'nope' },
        { actorUserId: '0' },
        { targetUserId: 'abc' },
        { targetType: 'session' },
        { targetId: '' },
        { targetId: 'x'.repeat(65) },
        { requestId: 'not-a-uuid' },
        { from: 'yesterday' },
        { to: '2026-13-01' },
        { cursor: 'has space' },
        { cursor: 'a'.repeat(129) },
        { unknown: '1' },
    ]) {
        assert.ok(isError(AdminAuditEventsQuerySchema(bad)), JSON.stringify(bad))
    }
})

test('the response schema accepts a page', () => {
    const page = {
        status: 'success',
        items: [
            {
                id: '1',
                occurredAt: '2026-11-20T10:00:00.000Z',
                action: 'auth.password.reset',
                group: 'sign-in',
                actor: {
                    kind: 'proof_holder',
                    userId: null,
                    name: null,
                    deleted: false,
                    role: null,
                    proof: 'email_link',
                    source: null,
                },
                target: { type: 'user', id: '7' },
                targetUser: { id: '7', name: 'Ann', deleted: false },
                requestId: '0f8fad5b-d9cb-469f-a165-70867728950e',
                changes: null,
                metadata: { proof: 'email_link', claimed: false },
            },
        ],
        nextCursor: null,
    }
    assert.ok(!isError(AdminAuditEventsResponseSchema(page)))
    assert.ok(
        isError(
            AdminAuditEventsResponseSchema({
                ...page,
                items: [{ ...page.items[0], action: 'unknown' }],
            }),
        ),
    )
})

test('every action lists the proofs its actor may carry', () => {
    for (const action of AUDIT_ACTION_NAMES) {
        const { actorKinds, proofs } = AUDIT_ACTIONS[action]
        // A proof holder acts by its proof alone: one is always required.
        if (actorKinds.includes('proof_holder')) assert.ok(proofs.length > 0, action)
    }
    assert.deepEqual(AUDIT_ACTIONS['auth.phone.linked'].proofs, ['sms_code'])
    assert.deepEqual(AUDIT_ACTIONS['auth.sessions.revoked_all'].proofs, [])
})

// feat-240 (Р7): a role change carries the roles only, and the source when the CLI made it.
test('user.role.changed projects the roles and adds the CLI source', () => {
    assert.deepEqual(
        buildAuditPayload(
            'user.role.changed',
            { from: 'user', to: 'kb_editor', email: 'x@y.z' },
            {},
        ),
        { changes: { role: { from: 'user', to: 'kb_editor' } }, metadata: null },
    )
    assert.deepEqual(
        buildAuditPayload('user.role.changed', { from: 'admin', to: 'user' }, { source: 'cli' }),
        { changes: { role: { from: 'admin', to: 'user' } }, metadata: { source: 'cli' } },
    )
})
