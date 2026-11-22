import { Result } from 'better-result'
import type { MyWebSocket } from '#vendor/types/types.js'
import { describe, expect, it, vi } from 'vitest'
import type { Role } from 'shared/access'
import type { SessionAuthState } from 'shared/mfa'

const broadcastMessageToUserConnection = vi.fn()
vi.mock('#app/services/communication/broadcast-service.js', () => ({
    broadcastService: { broadcastMessageToUserConnection },
}))

const { adminWsChannelService } = await import('./admin-ws-channel-service.js')

/**
 * feat-247 (Р11): MFA_REQUIRED_FOR_STAFF is on by default, so the socket's session proved its
 * second factor a moment ago; the refusals are in admin-channel-deadline.spec.ts.
 */
const staffAuth = (): SessionAuthState => {
    const at = new Date().toISOString()
    return {
        v: 1,
        amr: ['pwd', 'otp'],
        aal: 2,
        authenticatedAt: at,
        verified: { pwd: at, otp: at },
    }
}

function createWs(role: Role, adminChannelPaused = false) {
    const userData: {
        role: Role
        isAdminChannelSubscribed: boolean
        adminChannelPaused: boolean
        auth: SessionAuthState
    } = {
        role,
        isAdminChannelSubscribed: false,
        adminChannelPaused,
        auth: staffAuth(),
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
