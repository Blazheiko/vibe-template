import { describe, expect, it } from 'vitest'

import { pushSubscriptionTransformer } from './push-subscription-transformer.js'

const row = {
    id: 3n,
    userId: 7n,
    endpoint: 'https://push.example/1',
    p256dhKey: 'p256dh',
    authKey: 'auth',
    userAgent: null,
    ipAddress: null,
    isActive: true,
    createdAt: new Date('2026-10-25T10:00:00.000Z'),
    updatedAt: new Date('2026-10-25T10:01:00.000Z'),
    lastUsedAt: null,
    deviceType: null,
    browserName: null,
    browserVersion: null,
    osName: null,
    osVersion: null,
    notificationTypes: ['mention' as const],
    timezone: null,
}

describe('pushSubscriptionTransformer (feat-047 §4.2)', () => {
    it('sends ids as strings and dates as UTC ISO strings', () => {
        expect(
            pushSubscriptionTransformer.serialize({
                ...row,
                lastUsedAt: new Date('2026-10-25T10:02:00.000Z'),
            }),
        ).toMatchObject({
            id: '3',
            userId: '7',
            created_at: '2026-10-25T10:00:00.000Z',
            updated_at: '2026-10-25T10:01:00.000Z',
            lastUsedAt: '2026-10-25T10:02:00.000Z',
        })
    })

    // feat-208 (I-3)
    it('keeps the keys and the address on the server', () => {
        const serialized = pushSubscriptionTransformer.serialize({
            ...row,
            ipAddress: '203.0.113.7',
        })
        const withLogs = pushSubscriptionTransformer.serializeWithLogs({
            ...row,
            ipAddress: '203.0.113.7',
            notificationLogs: [],
        })

        for (const value of [serialized, withLogs]) {
            expect(value).not.toHaveProperty('p256dhKey')
            expect(value).not.toHaveProperty('authKey')
            expect(value).not.toHaveProperty('ipAddress')
            expect(value.endpoint).toBe('https://push.example/1')
        }
    })

    it('serializes the nested log summaries too', () => {
        const serialized = pushSubscriptionTransformer.serializeWithLogs({
            ...row,
            notificationLogs: [
                {
                    id: 11n,
                    messageTitle: 'Hi',
                    status: 'SENT',
                    sentAt: new Date('2026-10-25T10:03:00.000Z'),
                },
            ],
        })
        expect(serialized.lastUsedAt).toBeNull()
        expect(serialized.notificationLogs).toEqual([
            { id: '11', messageTitle: 'Hi', status: 'SENT', sentAt: '2026-10-25T10:03:00.000Z' },
        ])
    })
})
