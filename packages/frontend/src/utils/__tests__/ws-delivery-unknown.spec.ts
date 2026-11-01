import { describe, expect, it } from 'vitest'

import { buildApiError, isDeliveryUnknown, WsDeliveryUnknownError } from '../websocket-types'

// A request whose answer never came may have been accepted by the server; only an explicit
// answer, or a failure before anything was sent, means the server did not take it.
describe('isDeliveryUnknown', () => {
    it('is true for a timeout or a reset connection', () => {
        expect(isDeliveryUnknown(new WsDeliveryUnknownError('Request timeout'))).toBe(true)
        expect(isDeliveryUnknown(new WsDeliveryUnknownError('WebSocket connection reset'))).toBe(
            true,
        )
    })

    it('is false for an explicit refusal of the server', () => {
        const refusal = buildApiError({
            event: 'api/support/support_chat',
            status: '429',
            timestamp: 1,
            payload: {},
            code: 'rate_limited',
            error: { code: 'rate_limited', message: 'Too many messages.' },
        })

        expect(isDeliveryUnknown(refusal)).toBe(false)
    })

    it('is false for a failure before anything was sent', () => {
        expect(isDeliveryUnknown(new Error('WebSocket not connected'))).toBe(false)
        expect(isDeliveryUnknown(new Error('Request already in progress'))).toBe(false)
    })

    it('is false for anything else', () => {
        expect(isDeliveryUnknown(undefined)).toBe(false)
        expect(isDeliveryUnknown('boom')).toBe(false)
    })
})
