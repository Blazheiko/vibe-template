import { describe, expect, it, vi } from 'vitest'

import { hasPendingRequest, settleApiResponse, type ApiResolveItem } from '../ws-api-response'
import type { WebsocketMessage } from '../websocket-types'

const pendingFor = (id: string) => {
    const item: ApiResolveItem = {
        resolve: vi.fn(),
        reject: vi.fn(),
        timeout: window.setTimeout(() => {}, 10_000),
    }
    return { item, pending: { [id]: item } as Record<string, ApiResolveItem> }
}

describe('settleApiResponse', () => {
    it('rejects the matching request at once on service_unavailable', () => {
        const { item, pending } = pendingFor('req-1')
        const response = {
            event: 'api/user/me',
            id: 'req-1',
            status: 'error',
            data: null,
            timestamp: Date.now(),
            error: {
                code: 'service_unavailable',
                message: 'Service temporarily unavailable. Try again later.',
            },
        } as unknown as WebsocketMessage

        settleApiResponse(pending, response)

        expect(item.resolve).not.toHaveBeenCalled()
        expect(item.reject).toHaveBeenCalledWith(
            expect.objectContaining({ code: 'service_unavailable' }),
        )
        expect(pending).toEqual({})
    })

    it('resolves a successful response', () => {
        const { item, pending } = pendingFor('req-1')
        const response = {
            event: 'api/user/me',
            id: 'req-1',
            status: 'success',
            data: {},
            timestamp: Date.now(),
        } as unknown as WebsocketMessage

        settleApiResponse(pending, response)

        expect(item.resolve).toHaveBeenCalledWith(response)
        expect(item.reject).not.toHaveBeenCalled()
    })

    it('ignores responses without a pending request', () => {
        const { item, pending } = pendingFor('req-a')
        settleApiResponse(pending, {
            event: 'api/a',
            id: 'req-b',
            status: 'error',
        } as unknown as WebsocketMessage)
        // feat-180: the same event without the id is not the reply either.
        settleApiResponse(pending, {
            event: 'api/a',
            status: 'error',
        } as unknown as WebsocketMessage)
        expect(item.reject).not.toHaveBeenCalled()
        expect(Object.keys(pending)).toEqual(['req-a'])
    })
})

describe('hasPendingRequest', () => {
    it('finds a request by the id its reply carries, not by the event (feat-180)', () => {
        const { pending } = pendingFor('req-1')
        expect(hasPendingRequest(pending, { id: 'req-1' })).toBe(true)
        expect(hasPendingRequest(pending, { id: 'req-2' })).toBe(false)
        expect(hasPendingRequest(pending, {})).toBe(false)
    })
})
