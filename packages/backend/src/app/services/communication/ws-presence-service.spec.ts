import { beforeEach, describe, expect, it, vi } from 'vitest'

// feat-124: the admin online list. The upsert is built from a database snapshot; a user who went
// offline while it was read has had the remove sent already, so the upsert must not follow.
const snapshot = vi.hoisted(() => vi.fn())
vi.mock('#app/services/admin/admin-online-users-service.js', () => ({
    adminOnlineUsersService: { getOnlineUserSnapshot: snapshot },
}))
vi.mock('#app/services/admin/admin-ws-channel-service.js', () => ({
    adminWsChannelService: { hasSubscribers: () => true },
}))
const toChannel = vi.hoisted(() => vi.fn(() => true))
vi.mock('#app/services/communication/broadcast-service.js', () => ({
    broadcastService: { broadcastMessageToChannel: toChannel },
}))
const online = vi.hoisted(() => ({ value: true }))
vi.mock('#app/websocket/ws-connection-registry.js', () => ({
    wsConnectionRegistry: { isUserOnline: () => online.value },
}))
vi.mock('#logger', () => ({ default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }))

const { wsPresenceService } = await import('./ws-presence-service.js')

const USER = {
    id: '7',
    name: 'Ada',
    email: 'ada@example.test',
    appType: 'web',
    userAgent: 'ua',
    connectionsCount: 1,
}
const connected = (): Parameters<typeof wsPresenceService.onUserConnected>[0] =>
    ({ userId: '7', sessionId: 's', uuid: 'u', ip: '', userAgent: '', timestamp: 0 }) as never

beforeEach(() => {
    vi.clearAllMocks()
    online.value = true
})

describe('admin online upsert (feat-124)', () => {
    it('is sent while the user is still connected', async () => {
        snapshot.mockResolvedValue(USER)

        await wsPresenceService.onUserConnected(connected())

        expect(toChannel).toHaveBeenCalledWith(
            'admin',
            'admin_user_online_upsert',
            expect.objectContaining({ id: '7' }),
        )
    })

    it('is not sent when the user went offline while the snapshot was read', async () => {
        snapshot.mockImplementation(() => {
            // The last connection closed meanwhile; its remove has gone out.
            online.value = false
            return Promise.resolve(USER)
        })

        await wsPresenceService.onUserConnected(connected())

        expect(toChannel).not.toHaveBeenCalled()
    })
})
