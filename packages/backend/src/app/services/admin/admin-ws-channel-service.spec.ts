import { Result } from 'better-result'
import type { MyWebSocket } from '#vendor/types/types.js'
import { describe, expect, it, vi } from 'vitest'
import type { Role } from 'shared/access'

const broadcastMessageToUserConnection = vi.fn()
vi.mock('#app/services/communication/broadcast-service.js', () => ({
    broadcastService: { broadcastMessageToUserConnection },
}))

const { adminWsChannelService } = await import('./admin-ws-channel-service.js')

function createWs(role: Role, adminChannelPaused = false) {
    const userData: { role: Role; isAdminChannelSubscribed: boolean; adminChannelPaused: boolean } =
        {
            role,
            isAdminChannelSubscribed: false,
            adminChannelPaused,
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
    // feat-240: the channel follows users.read, and a paused channel refuses until a read succeeds.
    it.each<[Role]>([['support_operator'], ['user_admin']])(
        'subscribes %s, which has users.read',
        (role) => {
            const { ws, subscribe } = createWs(role)
            expect(Result.isOk(adminWsChannelService.subscribeCurrentAdminConnection(ws))).toBe(
                true,
            )
            expect(subscribe).toHaveBeenCalledWith('admin')
        },
    )

    it('refuses kb_editor and a paused channel', () => {
        const editor = createWs('kb_editor')
        expect(
            Result.isError(adminWsChannelService.subscribeCurrentAdminConnection(editor.ws)),
        ).toBe(true)
        const paused = createWs('admin', true)
        expect(
            Result.isError(adminWsChannelService.subscribeCurrentAdminConnection(paused.ws)),
        ).toBe(true)
        expect(paused.subscribe).not.toHaveBeenCalled()
    })

    it('leaves the channel idempotently, whatever the role', async () => {
        vi.resetModules()
        const service = (await import('./admin-ws-channel-service.js')).adminWsChannelService
        const { ws, unsubscribe } = createWs('admin')
        service.subscribeCurrentAdminConnection(ws)
        ws.getUserData().role = 'user'

        expect(service.unsubscribeCurrentAdminConnection(ws)).toEqual({ ok: true })
        expect(service.unsubscribeCurrentAdminConnection(ws)).toEqual({ ok: true })
        expect(unsubscribe).toHaveBeenCalledTimes(1)
        expect(service.hasSubscribers()).toBe(false)
    })
})
