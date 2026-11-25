import { describe, expect, it } from 'vitest'
import {
    BROADCAST_EVENT_NAMES,
    BroadcastEventSchemas,
    type BroadcastEventName,
} from 'shared/schemas'

import { broadcastGuards } from '../ws-payload-guards'

// Parity of the hand-written guards with the broadcast registry (feat-049 §4.5): ArkType
// is imported here only, the bundle stays without it. A guard rejects undeclared keys,
// so it is compared with the schema under onDeepUndeclaredKey('reject').

// The registry the app uses (feat-182): complete by its type.
const guards: Record<BroadcastEventName, (value: unknown) => boolean> = broadcastGuards

const upsert = {
    id: '42',
    name: 'Ada',
    email: 'ada@example.test',
    appType: 'pwa',
    userAgent: 'Mozilla/5.0',
    connectionsCount: 2,
}

const profile = {
    name: 'Ann',
    preferences: { locale: 'uk', timeZone: 'UTC', theme: 'dark', colorTheme: 'mint', fontSize: 18 },
    revision: '12',
}
const withPreferences = (fields: Record<string, unknown>) => ({
    ...profile,
    preferences: { ...profile.preferences, ...fields },
})

const valid: Record<BroadcastEventName, Record<string, unknown>> = {
    support_chat_token: { token: 'Hel' },
    support_chat_complete: { content: 'Hello', screenshots: ['1', '2'] },
    support_chat_error: { message: 'failed', code: 'chat_failed' },
    admin_user_online_upsert: upsert,
    admin_user_online_remove: { id: '42' },
    user_profile_updated: profile,
    user_sessions_changed: {},
    notifications_changed: {},
    notification_preferences_changed: {},
    access_changed: { role: 'kb_editor' },
    admin_channel_ready: {},
}

// Event-specific edge cases on top of the generic ones below.
const specific: Record<BroadcastEventName, [string, unknown][]> = {
    support_chat_token: [
        ['empty token', { token: '' }],
        ['with the id of its message', { token: 'x', clientMessageId: 'abc' }],
        ['numeric message id', { token: 'x', clientMessageId: 1 }],
    ],
    support_chat_complete: [
        ['no screenshots', { content: 'x', screenshots: [] }],
        ['missing screenshots', { content: 'x' }],
        ['numeric screenshot', { content: 'x', screenshots: [1] }],
        ['screenshots not an array', { content: 'x', screenshots: '1' }],
        ['with the id of its message', { content: 'x', screenshots: [], clientMessageId: 'abc' }],
        ['numeric message id', { content: 'x', screenshots: [], clientMessageId: 1 }],
    ],
    support_chat_error: [
        ['numeric message', { message: 1 }],
        ['numeric code', { message: 'failed', code: 1 }],
        ['no code is fine for the schema, so the guard must agree', { message: 'failed' }],
        ['with the id of its message', { message: 'failed', clientMessageId: 'abc' }],
        ['numeric message id', { message: 'failed', clientMessageId: 1 }],
    ],
    admin_user_online_upsert: [
        ['web appType', { ...upsert, appType: 'web' }],
        ['unknown appType', { ...upsert, appType: 'desktop' }],
        ['id 0', { ...upsert, id: '0' }],
        ['id with leading zero', { ...upsert, id: '042' }],
        ['the largest id (feat-262)', { ...upsert, id: '9223372036854775807' }],
        ['an id above the bigint bound', { ...upsert, id: '9223372036854775808' }],
        ['an id with a leading space', { ...upsert, id: ' 1' }],
        ['numeric id', { ...upsert, id: 42 }],
        ['missing email', { ...upsert, email: undefined }],
        ['connectionsCount as string', { ...upsert, connectionsCount: '2' }],
    ],
    admin_user_online_remove: [
        ['non-numeric id', { id: 'abc' }],
        ['id 0', { id: '0' }],
        ['id with leading zero', { id: '007' }],
        ['the largest id (feat-262)', { id: '9223372036854775807' }],
        ['an id above the bigint bound', { id: '9223372036854775808' }],
        ['numeric id', { id: 42 }],
    ],
    user_profile_updated: [
        [
            'every preference null',
            withPreferences({
                locale: null,
                timeZone: null,
                theme: null,
                colorTheme: null,
                fontSize: null,
            }),
        ],
        ['revision 0', { ...profile, revision: '0' }],
        ['numeric revision', { ...profile, revision: 12 }],
        ['negative revision', { ...profile, revision: '-1' }],
        ['revision with a leading zero', { ...profile, revision: '012' }],
        ['locale not shipped', withPreferences({ locale: 'de' })],
        ['unknown theme', withPreferences({ theme: 'system' })],
        ['unknown color', withPreferences({ colorTheme: 'red' })],
        ['font size 13', withPreferences({ fontSize: 13 })],
        ['font size 21', withPreferences({ fontSize: 21 })],
        ['font size 16.5', withPreferences({ fontSize: 16.5 })],
        ['font size as string', withPreferences({ fontSize: '16' })],
        ['numeric zone', withPreferences({ timeZone: 1 })],
        ['extra preference', withPreferences({ language: 'uk' })],
        ['missing preference', { ...profile, preferences: { locale: 'uk' } }],
        ['preferences null', { ...profile, preferences: null }],
    ],
    user_sessions_changed: [['any data', { sessions: [] }]],
    notifications_changed: [['a count', { unreadCount: 3 }]],
    notification_preferences_changed: [['any data', { push: true }]],
    access_changed: [
        ['an unknown role', { role: 'root' }],
        ['no role', {}],
        ['an extra key', { role: 'admin', permissions: [] }],
        ['an unknown reason', { role: 'admin', reason: 'bored' }],
    ],
    admin_channel_ready: [['any data', { ready: true }]],
}

const cases = BROADCAST_EVENT_NAMES.flatMap((event) => {
    const payload = valid[event]
    const [firstKey] = Object.keys(payload)
    const generic: [string, unknown][] = [
        ['valid payload', payload],
        ['extra key', { ...payload, isAdmin: true }],
        ['missing key', Object.fromEntries(Object.entries(payload).slice(1))],
        ['wrong type', { ...payload, [firstKey]: null }],
        ['array', [payload]],
        ['null', null],
        ['string', 'payload'],
    ]
    return [...generic, ...specific[event]].map(
        ([label, value]) => [event, label, value] as [BroadcastEventName, string, unknown],
    )
})

describe('broadcast payload guards', () => {
    it('cover every event of the registry', () => {
        expect(Object.keys(guards).sort()).toEqual([...BROADCAST_EVENT_NAMES].sort())
    })

    it.each(cases)('%s agrees with the ArkType schema: %s', (event, _label, payload) => {
        const schema = BroadcastEventSchemas[event].onDeepUndeclaredKey('reject')
        expect(guards[event](payload)).toBe(schema.allows(payload))
    })

    it.each(BROADCAST_EVENT_NAMES)('%s accepts its valid payload', (event) => {
        expect(guards[event](valid[event])).toBe(true)
    })
})

// feat-247: a staff session that lost the admin channel to its MFA freshness is told why.
describe('access_changed with the MFA reason (feat-247)', () => {
    it('is accepted', () => {
        expect(
            broadcastGuards.access_changed({ role: 'admin', reason: 'mfa_session_required' }),
        ).toBe(true)
    })
})

// feat-262: the id bound checked by the guard itself, not only through parity with the schema.
describe('admin_user_online_remove id bound (feat-262)', () => {
    it.each([
        ['9223372036854775807', true],
        ['9223372036854775808', false],
        ['0', false],
        ['007', false],
        [' 1', false],
    ])('id %j is accepted: %s', (id, accepted) => {
        expect(broadcastGuards.admin_user_online_remove({ id })).toBe(accepted)
    })
})
