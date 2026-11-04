import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { MyWebSocket, UserConnection } from '#vendor/types/types.js'

// feat-107 (R04): the real coordinator and connection registry. A socket that closed while its
// role was read never enters the registry, and the registry never reads getUserData() from a
// stored socket, which throws once that socket has closed.
vi.mock('#vendor/utils/logger.js', () => ({
    default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))
let resolveRole: (role: 'user' | 'admin' | undefined) => void = () => undefined
vi.mock('#app/services/user/user-role-service.js', () => ({
    userRoleService: {
        findRole: vi.fn(
            () =>
                new Promise<'user' | 'admin' | undefined>((resolve) => {
                    resolveRole = resolve
                }),
        ),
    },
}))
vi.mock('#app/services/communication/user-online-service.js', () => ({
    userOnlineService: {
        trackConnected: vi.fn(() => Promise.resolve()),
        trackDisconnected: vi.fn(() => Promise.resolve()),
    },
}))
const onUserConnected = vi.hoisted(() => vi.fn(() => Promise.resolve()))
vi.mock('#app/services/communication/ws-presence-service.js', () => ({
    wsPresenceService: {
        onUserConnected,
        onUserDisconnected: vi.fn(() => Promise.resolve()),
    },
}))
vi.mock('#app/services/admin/admin-ws-channel-service.js', () => ({
    adminWsChannelService: { handleConnectionClosed: vi.fn() },
}))

const { websocketCoordinator } = await import('./ws-coordinator.js')
const { wsConnectionRegistry } = await import('./ws-connection-registry.js')

let counter = 0
const connection = (userId: string, appType: 'web' | 'pwa' = 'web') => {
    counter += 1
    let dead = false
    const userData: UserConnection = {
        ip: '203.0.113.1',
        userAgent: `agent-${String(counter)}`,
        ip2: '',
        token: '',
        user: null,
        appType,
        uuid: `uuid-${String(counter)}`,
        sessionId: 's1',
        userId,
        userToken: 'u1',
        timeStart: Date.now(),
    }
    const ws = {
        getUserData: () => {
            if (dead) throw new Error('Invalid access of closed uWS.WebSocket/SSLWebSocket.')
            return userData
        },
    } as unknown as MyWebSocket
    return {
        ws,
        userData,
        // What onClose does before uWS invalidates the socket.
        close: () => {
            userData.closed = true
            const disconnected = websocketCoordinator.handleDisconnected(ws, userData, 1001)
            dead = true
            return disconnected
        },
    }
}

const connect = async (conn: ReturnType<typeof connection>) => {
    const connected = websocketCoordinator.handleConnected(conn.ws, conn.userData)
    resolveRole('user')
    await connected
}

beforeEach(() => {
    vi.clearAllMocks()
})

describe('connection registry lifecycle (feat-107)', () => {
    it('a socket that closes while its role is read is never registered', async () => {
        const conn = connection('9101')

        const connected = websocketCoordinator.handleConnected(conn.ws, conn.userData)
        await conn.close()
        resolveRole('user')
        await connected

        expect(wsConnectionRegistry.isUserOnline('9101')).toBe(false)
        expect(wsConnectionRegistry.getConnection('9101', conn.userData.uuid)).toBeUndefined()
        expect(onUserConnected).not.toHaveBeenCalled()
    })

    it('a reload registers the new socket while the old one is dead', async () => {
        const old = connection('9102')
        await connect(old)
        // The window before feat-107: uWS has invalidated the old socket while its close
        // handler still waits on Redis, so it is still in the registry.
        ;(old.ws as unknown as { getUserData: () => never }).getUserData = () => {
            throw new Error('Invalid access of closed uWS.WebSocket/SSLWebSocket.')
        }

        const fresh = connection('9102', 'pwa')
        await expect(connect(fresh)).resolves.toBeUndefined()

        expect(wsConnectionRegistry.getConnection('9102', fresh.userData.uuid)).toBe(fresh.ws)
        expect(wsConnectionRegistry.getOnlineUserMeta('9102')?.appType).toBe('pwa')

        // The old socket's close handler now finishes; only the fresh socket stays.
        await websocketCoordinator.handleDisconnected(old.ws, old.userData, 1001)
        expect(wsConnectionRegistry.getConnection('9102', old.userData.uuid)).toBeUndefined()
        expect(wsConnectionRegistry.getConnection('9102', fresh.userData.uuid)).toBe(fresh.ws)
    })

    it('summaries never read a stored socket', async () => {
        const first = connection('9103', 'pwa')
        const second = connection('9103', 'web')
        await connect(first)
        await connect(second)

        // Both sockets are dead to getUserData from here on; the registry keeps working.
        const dead = () => {
            throw new Error('Invalid access of closed uWS.WebSocket/SSLWebSocket.')
        }
        ;(first.ws as unknown as { getUserData: () => never }).getUserData = dead
        ;(second.ws as unknown as { getUserData: () => never }).getUserData = dead

        const meta = wsConnectionRegistry.getOnlineUserMeta('9103')
        expect(meta?.appType).toBe('pwa')
        expect(meta?.connections.map((c) => c.appType).sort()).toEqual(['pwa', 'web'])
        expect(() =>
            wsConnectionRegistry.unregisterConnection('9103', first.userData.uuid),
        ).not.toThrow()
        expect(wsConnectionRegistry.getOnlineUserMeta('9103')?.appType).toBe('web')
    })
})
