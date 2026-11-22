import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
    NOTIFICATION_CATEGORIES,
    NOTIFICATION_CHANNEL_POLICY,
    NOTIFICATION_KINDS,
    NOTIFICATION_KIND_NAMES,
    buildNotificationLink,
    isNotificationLink,
    resolveNotificationPreferences,
} from '../dist/notifications/index.js'
import {
    BroadcastEventSchemas,
    ListNotificationsQuerySchema,
    NotificationParamsSchemas,
    ReadAllNotificationsInputSchema,
    UpdateNotificationPreferenceInputSchema,
} from '../dist/schemas/index.js'
import { NotificationItemSchema } from '../dist/responses/index.js'

const isError = (result) => result !== null && typeof result === 'object' && 'summary' in result

// feat-236 (Р2): every kind of the catalog has a category, a params schema and a link that may
// be stored.
test('every kind has a known category, a params schema and a storable link', () => {
    // 9 of feat-236, 4 security kinds of feat-245 (MFA), 2 of feat-246 (passkeys), 1 of feat-247.
    assert.equal(NOTIFICATION_KIND_NAMES.length, 16)
    for (const kind of NOTIFICATION_KIND_NAMES) {
        const definition = NOTIFICATION_KINDS[kind]
        assert.ok(NOTIFICATION_CATEGORIES.includes(definition.category), kind)
        assert.ok(kind.startsWith(`${definition.category}.`), kind)
        assert.equal(typeof NotificationParamsSchemas[kind], 'function', kind)
        const link = buildNotificationLink(kind, {})
        assert.ok(link === null || isNotificationLink(link), `${kind}: ${String(link)}`)
    }
    assert.deepEqual(
        Object.keys(NotificationParamsSchemas).sort(),
        [...NOTIFICATION_KIND_NAMES].sort(),
    )
})

test('params: only the declared keys, short strings, known providers', () => {
    const P = NotificationParamsSchemas
    assert.deepEqual(P['security.new_sign_in']({ device: 'Chrome on macOS' }), {
        device: 'Chrome on macOS',
    })
    assert.ok(isError(P['security.new_sign_in']({})))
    assert.ok(isError(P['security.new_sign_in']({ device: '' })))
    assert.ok(isError(P['security.new_sign_in']({ device: 'x'.repeat(129) })))
    assert.ok(!isError(P['security.new_sign_in']({ device: 'x'.repeat(128) })))
    assert.ok(isError(P['security.new_sign_in']({ device: 'a', ip: '1.2.3.4' })))
    assert.ok(!isError(P['security.method_added']({ provider: 'github' })))
    assert.ok(isError(P['security.method_added']({ provider: 'GitHub' })))
    assert.ok(isError(P['security.method_removed']({})))
    assert.ok(!isError(P['security.session_revoked']({})))
    assert.ok(!isError(P['security.session_revoked']({ device: 'Firefox on Linux' })))
    assert.ok(!isError(P['support.reply']({})))
    assert.ok(isError(P['support.reply']({ text: 'hi' })))
})

test('resolveNotificationPreferences: defaults, stored rows, locked channels', () => {
    const defaults = resolveNotificationPreferences([])
    assert.deepEqual(defaults, [
        { category: 'security', channel: 'push', enabled: true, locked: false },
        { category: 'security', channel: 'email', enabled: true, locked: true },
        { category: 'support', channel: 'push', enabled: true, locked: false },
    ])
    const stored = resolveNotificationPreferences([
        { category: 'support', channel: 'push', enabled: false },
        // A locked channel keeps its default whatever is stored.
        { category: 'security', channel: 'email', enabled: false },
        // A channel the category does not have is not in the matrix.
        { category: 'support', channel: 'email', enabled: true },
    ])
    assert.deepEqual(
        stored.map((cell) => `${cell.category}.${cell.channel}=${String(cell.enabled)}`),
        ['security.push=true', 'security.email=true', 'support.push=false'],
    )
    assert.equal(NOTIFICATION_CHANNEL_POLICY.support.email, undefined)
})

test('isNotificationLink: one leading slash, no scheme or host', () => {
    for (const ok of ['/account#sessions', '/support?tab=chat', '/', '/notifications/12/open']) {
        assert.equal(isNotificationLink(ok), true, ok)
    }
    for (const bad of [
        '//evil.example.net',
        '/\\evil.example.net',
        'https://app.example.com/x',
        'account',
        'javascript:alert(1)',
        '',
        '/a b',
        '/a\nb',
        `/${'a'.repeat(512)}`,
        null,
        42,
    ]) {
        assert.equal(isNotificationLink(bad), false, String(bad))
    }
})

// Р6: limit 1–50 with 20 by default; ids are positive decimals of at most 19 digits (the bigint
// bound itself is checked by the backend before the query).
test('list query: default limit, bounds, ids', () => {
    assert.deepEqual(ListNotificationsQuerySchema({}), { limit: 20 })
    assert.deepEqual(ListNotificationsQuerySchema({ limit: '50', unread: '1', before: '9' }), {
        limit: 50,
        unread: '1',
        before: '9',
    })
    for (const query of [
        { limit: '0' },
        { limit: '51' },
        { before: '0' },
        { before: '01' },
        { before: '-1' },
        { before: '1'.repeat(20) },
        { unread: 'true' },
        { other: 'x' },
    ]) {
        assert.ok(isError(ListNotificationsQuerySchema(query)), JSON.stringify(query))
    }
    assert.ok(!isError(ListNotificationsQuerySchema({ before: '9223372036854775807' })))
})

test('read-all and preference bodies', () => {
    assert.deepEqual(ReadAllNotificationsInputSchema({ upTo: '12' }), { upTo: '12' })
    assert.ok(isError(ReadAllNotificationsInputSchema({ upTo: 12 })))
    assert.ok(isError(ReadAllNotificationsInputSchema({ upTo: '0' })))
    assert.ok(isError(ReadAllNotificationsInputSchema({})))
    assert.ok(
        !isError(
            UpdateNotificationPreferenceInputSchema({
                category: 'support',
                channel: 'push',
                enabled: false,
            }),
        ),
    )
    assert.ok(
        isError(
            UpdateNotificationPreferenceInputSchema({
                category: 'system',
                channel: 'push',
                enabled: false,
            }),
        ),
    )
})

test('a notification item matches its own kind only', () => {
    const base = { id: '7', link: '/account', createdAt: '2026-11-20T10:00:00.000Z', readAt: null }
    assert.ok(
        !isError(
            NotificationItemSchema({
                ...base,
                kind: 'security.method_added',
                category: 'security',
                params: { provider: 'gitlab' },
            }),
        ),
    )
    assert.ok(
        isError(
            NotificationItemSchema({
                ...base,
                kind: 'support.reply',
                category: 'security',
                params: {},
            }),
        ),
    )
    assert.ok(
        isError(
            NotificationItemSchema({
                ...base,
                kind: 'security.new_sign_in',
                category: 'security',
                params: {},
            }),
        ),
    )
})

test('the notification signals carry no data', () => {
    assert.deepEqual(BroadcastEventSchemas.notifications_changed({}), {})
    assert.deepEqual(BroadcastEventSchemas.notification_preferences_changed({}), {})
})
