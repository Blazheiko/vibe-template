import { Result } from 'better-result'
import type { MyWebSocket } from '#vendor/types/types.js'
import { describe, expect, it, vi } from 'vitest'
import { adminWsChannelService } from './admin-ws-channel-service.js'

function createWs(role: 'admin' | 'user') {
    const userData = {
        role,
        isAdminChannelSubscribed: false,
    }
    const subscribe = vi.fn()
    const unsubscribe = vi.fn()
    const ws = {
        getUserData: vi.fn(() => userData),
        subscribe,
        unsubscribe,
    } as unknown as MyWebSocket

    return { ws, subscribe, unsubscribe }
}

describe('adminWsChannelService', () => {
    it('returns forbidden for non-admin users', () => {
        const { ws } = createWs('user')

        const result = adminWsChannelService.subscribeCurrentAdminConnection(ws)

        expect(Result.isError(result)).toBe(true)
        if (Result.isError(result)) {
            expect(result.error).toEqual({
                _tag: 'Forbidden',
                message: 'Access denied',
            })
        }
    })

    it('subscribes admin users to the admin channel', () => {
        const { ws, subscribe } = createWs('admin')

        const result = adminWsChannelService.subscribeCurrentAdminConnection(ws)

        expect(Result.isOk(result)).toBe(true)
        expect(subscribe).toHaveBeenCalledWith('admin')
    })
    describe('revokeAdminAccess', () => {
        // The subscriber count is module state: a fresh module for each test.
        const freshService = async (): Promise<typeof adminWsChannelService> => {
            vi.resetModules()
            return (await import('./admin-ws-channel-service.js')).adminWsChannelService
        }

        it('takes the channel and the role from a subscribed admin connection', async () => {
            const service = await freshService()
            const { ws, unsubscribe } = createWs('admin')
            service.subscribeCurrentAdminConnection(ws)
            expect(service.hasSubscribers()).toBe(true)

            service.revokeAdminAccess(ws)

            expect(unsubscribe).toHaveBeenCalledWith('admin')
            expect(ws.getUserData().role).toBe('user')
            expect(ws.getUserData().isAdminChannelSubscribed).toBe(false)
            expect(service.hasSubscribers()).toBe(false)
            // And it cannot subscribe again on this connection.
            expect(Result.isError(service.subscribeCurrentAdminConnection(ws))).toBe(true)
        })

        it('only drops the role of an admin connection that never subscribed', async () => {
            const service = await freshService()
            const { ws, unsubscribe } = createWs('admin')

            service.revokeAdminAccess(ws)

            expect(unsubscribe).not.toHaveBeenCalled()
            expect(ws.getUserData().role).toBe('user')
            expect(service.hasSubscribers()).toBe(false)
        })
    })
})
