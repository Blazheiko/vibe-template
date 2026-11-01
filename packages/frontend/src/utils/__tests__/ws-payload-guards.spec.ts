import { describe, expect, it } from 'vitest'
import {
    BROADCAST_EVENT_NAMES,
    BroadcastEventSchemas,
    type BroadcastEventName,
} from 'shared/schemas'

import {
    isAdminUserOnlineRemovePayload,
    isSupportChatCompletePayload,
    isSupportChatErrorPayload,
    isSupportChatTokenPayload,
    isWSAdminUserOnlineUpsertPayload,
} from '../ws-payload-guards'

// Parity of the hand-written guards with the broadcast registry (feat-049 §4.5): ArkType
// is imported here only, the bundle stays without it. A guard rejects undeclared keys,
// so it is compared with the schema under onDeepUndeclaredKey('reject').

const guards: Record<BroadcastEventName, (value: unknown) => boolean> = {
    support_chat_token: isSupportChatTokenPayload,
    support_chat_complete: isSupportChatCompletePayload,
    support_chat_error: isSupportChatErrorPayload,
    admin_user_online_upsert: isWSAdminUserOnlineUpsertPayload,
    admin_user_online_remove: isAdminUserOnlineRemovePayload,
}

const upsert = {
    id: '42',
    name: 'Ada',
    email: 'ada@example.test',
    appType: 'pwa',
    userAgent: 'Mozilla/5.0',
    connectionsCount: 2,
}

const valid: Record<BroadcastEventName, Record<string, unknown>> = {
    support_chat_token: { token: 'Hel' },
    support_chat_complete: { content: 'Hello', screenshots: ['1', '2'] },
    support_chat_error: { message: 'failed', code: 'chat_failed' },
    admin_user_online_upsert: upsert,
    admin_user_online_remove: { id: '42' },
}

// Event-specific edge cases on top of the generic ones below.
const specific: Record<BroadcastEventName, [string, unknown][]> = {
    support_chat_token: [['empty token', { token: '' }]],
    support_chat_complete: [
        ['no screenshots', { content: 'x', screenshots: [] }],
        ['missing screenshots', { content: 'x' }],
        ['numeric screenshot', { content: 'x', screenshots: [1] }],
        ['screenshots not an array', { content: 'x', screenshots: '1' }],
    ],
    support_chat_error: [
        ['numeric message', { message: 1 }],
        ['numeric code', { message: 'failed', code: 1 }],
        ['no code is fine for the schema, so the guard must agree', { message: 'failed' }],
    ],
    admin_user_online_upsert: [
        ['web appType', { ...upsert, appType: 'web' }],
        ['unknown appType', { ...upsert, appType: 'desktop' }],
        ['id 0', { ...upsert, id: '0' }],
        ['id with leading zero', { ...upsert, id: '042' }],
        ['numeric id', { ...upsert, id: 42 }],
        ['missing email', { ...upsert, email: undefined }],
        ['connectionsCount as string', { ...upsert, connectionsCount: '2' }],
    ],
    admin_user_online_remove: [
        ['non-numeric id', { id: 'abc' }],
        ['numeric id', { id: 42 }],
    ],
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
