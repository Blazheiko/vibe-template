import { describe, expect, it } from 'vitest'

import { pushNotificationLogTransformer } from './push-notification-log-transformer.js'

const row = {
    id: 11n,
    userId: 7n,
    subscriptionId: 3n,
    messageTitle: 'Hi',
    messageBody: 'Body',
    messageData: { url: '/' },
    sentAt: new Date('2026-10-25T10:00:00.000Z'),
    status: 'SENT' as const,
    errorMessage: null,
    responseData: { statusCode: 201 },
}

describe('pushNotificationLogTransformer', () => {
    it('sends ids as strings and sentAt as an ISO string', () => {
        const { errorMessage: _errorMessage, responseData: _responseData, ...rest } = row
        expect(pushNotificationLogTransformer.serialize(row)).toEqual({
            ...rest,
            id: '11',
            userId: '7',
            subscriptionId: '3',
            sentAt: '2026-10-25T10:00:00.000Z',
            statusCode: 201,
            reason: null,
        })
    })

    // feat-104: the transport error text could carry what an internal host answered.
    it('never sends the error text or the raw response', () => {
        const serialized = pushNotificationLogTransformer.serialize({
            ...row,
            status: 'FAILED',
            errorMessage: 'connect ECONNREFUSED 10.0.0.5:22',
            responseData: { statusCode: null },
        })
        expect(serialized).not.toHaveProperty('errorMessage')
        expect(serialized).not.toHaveProperty('responseData')
        expect(JSON.stringify(serialized)).not.toContain('ECONNREFUSED')
    })

    it.each([
        ['SENT', 201, null],
        ['FAILED', 410, 'gone'],
        ['FAILED', 404, 'gone'],
        ['FAILED', 403, 'rejected'],
        ['FAILED', 302, 'rejected'],
        ['FAILED', null, 'network_error'],
    ] as const)('status %s with code %s gives reason %s', (status, statusCode, reason) => {
        const serialized = pushNotificationLogTransformer.serialize({
            ...row,
            status,
            responseData: { statusCode },
        })
        expect(serialized).toMatchObject({ statusCode, reason })
    })

    it('reads a missing response as no status code', () => {
        const serialized = pushNotificationLogTransformer.serialize({
            ...row,
            status: 'FAILED',
            responseData: null,
        })
        expect(serialized).toMatchObject({ statusCode: null, reason: 'network_error' })
    })

    it('keeps null user and subscription ids', () => {
        const serialized = pushNotificationLogTransformer.serialize({
            ...row,
            userId: null,
            subscriptionId: null,
        })
        expect(serialized).toMatchObject({ userId: null, subscriptionId: null })
    })

    it('serializes a log summary', () => {
        expect(
            pushNotificationLogTransformer.serializeSummary({
                id: 11n,
                messageTitle: null,
                status: null,
                sentAt: new Date('2026-10-25T10:00:00.000Z'),
            }),
        ).toEqual({
            id: '11',
            messageTitle: null,
            status: null,
            sentAt: '2026-10-25T10:00:00.000Z',
        })
    })
})
