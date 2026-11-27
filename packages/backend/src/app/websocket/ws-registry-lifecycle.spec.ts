import { beforeEach, describe, expect, it, vi } from 'vitest'
import { sessionIdOf, type SessionToken } from '#app/domain/secrets.js'

import type { MyWebSocket, UserConnection } from '#vendor/types/types.js'

// feat-107 (R04): the real coordinator and connection registry. A socket that closed while its
// role was read never enters the registry, and the registry never reads getUserData() from a
// stored socket, which throws once that socket has closed.
vi.mock('#vendor/utils/logger.js', () => ({
    default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))
// The read of handleConnected, held until the test answers it: the role, and the current
// users.session_token ('u1' is what every test connection was opened with).
let resolveAccess: (
    access: { role: 'user' | 'admin'; sessionToken: string } | undefined,
) => void = () => undefined
const resolveRole = (role: 'user' | 'admin' | undefined): void => {
    resolveAccess(role === undefined ? undefined : { role, sessionToken: 'u1' })
}
vi.mock('#app/services/user/user-role-service.js', () => ({
    userRoleService: {
        findAccess: vi.fn(
            () =>
                new Promise<{ role: 'user' | 'admin'; sessionToken: string } | undefined>(
                    (resolve) => {
                        resolveAccess = resolve
                    },
                ),
        ),
    },
}))
// feat-210: the stored session of the connection (a logout of one session deletes it). Answers
// at once unless a test holds it.
const sessionExists = vi.hoisted(() => vi.fn(() => Promise.resolve(true)))
vi.mock('#vendor/utils/session/redis-session-storage.js', () => ({
    sessionExists,
    sessionsExist: vi.fn(),
}))
vi.mock('#app/repositories/index.js', () => ({ userRepository: {} }))
vi.mock('#config/websocket.js', () => ({ default: { sessionRecheckIntervalMs: 30_000 } }))
const online = vi.hoisted(() => ({
    trackConnected: vi.fn(() => Promise.resolve()),
    trackDisconnected: vi.fn(() => Promise.resolve()),
}))
vi.mock('#app/services/communication/user-online-service.js', () => ({
    userOnlineService: online,
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
// feat-233: the session list event and the lastSeenAt write of an opened socket.
const announceSessionListChanged = vi.hoisted(() => vi.fn())
vi.mock('#app/services/communication/session-list-announcer.js', () => ({
    announceSessionListChanged,
}))
const touchSessionFromWs = vi.hoisted(() => vi.fn(() => Promise.resolve()))
vi.mock('#vendor/utils/session/ws-session-touch.js', () => ({ touchSessionFromWs }))

// feat-243: wsRoleSync.onRoleChanged, whose refresh of registered connections tells them nothing here.
vi.mock('#app/services/communication/broadcast-service.js', () => ({
    broadcastService: { broadcastMessageToUserConnection: vi.fn() },
}))

const { websocketCoordinator } = await import('./ws-coordinator.js')
const { wsConnectionRegistry } = await import('./ws-connection-registry.js')
const { userRoleService } = await import('#app/services/user/user-role-service.js')
/** How many times handleConnected read the role. */
const accessReads = (): number => vi.mocked(userRoleService).findAccess.mock.calls.length
const { wsRoleSync } = await import('./ws-role-sync.js')

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
    const sent: string[] = []
    const endedWith: number[] = []
    const ws = {
        getUserData: () => {
            if (dead) throw new Error('Invalid access of closed uWS.WebSocket/SSLWebSocket.')
            return userData
        },
        cork: (fn: () => void): void => {
            fn()
        },
        send: (message: string): void => {
            sent.push(message)
        },
        end: (code: number): void => {
            endedWith.push(code)
        },
    } as unknown as MyWebSocket
    return {
        ws,
        userData,
        sent,
        endedWith,
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
    // The token in the database is the one the connection was opened with.
    resolveAccess({ role: 'user', sessionToken: conn.userData.userToken ?? '' })
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

// feat-124: the user_online row of a connection is completed only after its INSERT settled.
describe('the session of a registered connection (feat-195)', () => {
    it('keeps the session id and the user token the connection was opened with', async () => {
        const first = connection('9104')
        first.userData.sessionId = 'session-a'
        first.userData.userToken = 'token-a'
        const second = connection('9104')
        second.userData.sessionId = 'session-b'
        second.userData.userToken = 'token-a'
        const other = connection('9105')
        await connect(first)
        await connect(second)
        await connect(other)

        // A stored socket is never read for this (it throws once closed).
        const dead = () => {
            throw new Error('Invalid access of closed uWS.WebSocket/SSLWebSocket.')
        }
        ;(first.ws as unknown as { getUserData: () => never }).getUserData = dead

        expect(wsConnectionRegistry.listUserConnections('9104')).toEqual([
            {
                userId: '9104',
                uuid: first.userData.uuid,
                ws: first.ws,
                sessionId: 'session-a',
                userToken: 'token-a',
            },
            {
                userId: '9104',
                uuid: second.userData.uuid,
                ws: second.ws,
                sessionId: 'session-b',
                userToken: 'token-a',
            },
        ])
        expect(
            wsConnectionRegistry
                .listConnections()
                .filter((c) => c.userId === '9104' || c.userId === '9105')
                .map((c) => [c.userId, c.sessionId, c.userToken]),
        ).toEqual([
            ['9104', 'session-a', 'token-a'],
            ['9104', 'session-b', 'token-a'],
            ['9105', 's1', 'u1'],
        ])
        expect(wsConnectionRegistry.listUserConnections('9199')).toEqual([])
    })
})

describe('a session revoked while the connection is being opened (feat-209)', () => {
    it('closes the connection with 4001 instead of registering it', async () => {
        const conn = connection('9106')

        const connected = websocketCoordinator.handleConnected(conn.ws, conn.userData)
        // The session was revoked after the upgrade: the token in the database is another one.
        resolveAccess({ role: 'user', sessionToken: 'rotated' })
        await connected

        expect(conn.endedWith).toEqual([4001])
        expect(JSON.parse(String(conn.sent[0]))).toMatchObject({
            event: 'service:error',
            error: { code: 'unauthorized' },
        })
        expect(wsConnectionRegistry.isUserOnline('9106')).toBe(false)
        expect(online.trackConnected).not.toHaveBeenCalled()
        expect(onUserConnected).not.toHaveBeenCalled()
    })

    it('closes the connection of a user that no longer exists', async () => {
        const conn = connection('9107')

        const connected = websocketCoordinator.handleConnected(conn.ws, conn.userData)
        resolveAccess(undefined)
        await connected

        expect(conn.endedWith).toEqual([4001])
        expect(wsConnectionRegistry.isUserOnline('9107')).toBe(false)
    })

    it('registers a connection whose token is still current, with its role', async () => {
        const conn = connection('9108')

        const connected = websocketCoordinator.handleConnected(conn.ws, conn.userData)
        resolveAccess({ role: 'admin', sessionToken: 'u1' })
        await connected

        expect(conn.endedWith).toEqual([])
        expect(conn.userData.role).toBe('admin')
        expect(wsConnectionRegistry.getConnection('9108', conn.userData.uuid)).toBe(conn.ws)
        await conn.close()
    })

    it('a revocation right after the read finds the connection in the registry', async () => {
        const conn = connection('9109')

        const connected = websocketCoordinator.handleConnected(conn.ws, conn.userData)
        resolveAccess({ role: 'user', sessionToken: 'u1' })
        await connected

        // What closeUserConnections reads once the rotation is committed.
        expect(wsConnectionRegistry.listUserConnections('9109').map((c) => c.uuid)).toEqual([
            conn.userData.uuid,
        ])
        await conn.close()
    })
})

// feat-243 (review 2026-11-21): a role change signalled while the role was read; wsRoleSync does
// not see the connection yet, so the signal marks it and it reads its role again.
describe('a role change while the connection is being opened (feat-243)', () => {
    it('registers with the role read after the signal, not the one read before', async () => {
        const conn = connection('9150')
        const connected = websocketCoordinator.handleConnected(conn.ws, conn.userData)

        // The read answered with the old role; the signal is handled before the registration.
        wsConnectionRegistry.markConnectingRoleStale('9150')
        resolveAccess({ role: 'admin', sessionToken: 'u1' })
        await vi.waitFor(() => {
            expect(accessReads()).toBe(2)
        })
        expect(wsConnectionRegistry.isUserOnline('9150')).toBe(false)
        resolveAccess({ role: 'user', sessionToken: 'u1' })
        await connected

        expect(conn.userData.role).toBe('user')
        expect(wsConnectionRegistry.getConnection('9150', conn.userData.uuid)).toBe(conn.ws)
        await conn.close()
    })

    it('the server bus event marks the connections being opened', async () => {
        const conn = connection('9151')
        const connected = websocketCoordinator.handleConnected(conn.ws, conn.userData)

        void wsRoleSync.onRoleChanged('9151')
        resolveAccess({ role: 'admin', sessionToken: 'u1' })
        await vi.waitFor(() => {
            expect(accessReads()).toBe(2)
        })
        resolveAccess({ role: 'user', sessionToken: 'u1' })
        await connected

        expect(conn.userData.role).toBe('user')
        await conn.close()
    })

    it('a revocation during the second read still closes the connection', async () => {
        const conn = connection('9152')
        const connected = websocketCoordinator.handleConnected(conn.ws, conn.userData)

        wsConnectionRegistry.markConnectingRoleStale('9152')
        resolveAccess({ role: 'admin', sessionToken: 'u1' })
        await vi.waitFor(() => {
            expect(accessReads()).toBe(2)
        })
        wsConnectionRegistry.revokeConnecting('9152')
        resolveAccess({ role: 'user', sessionToken: 'u1' })
        await connected

        expect(conn.endedWith).toEqual([4001])
        expect(wsConnectionRegistry.isUserOnline('9152')).toBe(false)
    })

    it('reads once without a signal', async () => {
        const conn = connection('9153')
        await connect(conn)
        expect(accessReads()).toBe(1)
        expect(wsConnectionRegistry.markConnectingRoleStale('9153')).toBe(0)
        await conn.close()
    })
})

// feat-210: a logout of one session rotates no token, so the check of feat-209 does not see it.
describe('a logout while the connection is being opened (feat-210)', () => {
    it('closes a connection whose stored session is gone: the logout ran before the read', async () => {
        const conn = connection('9110')
        sessionExists.mockResolvedValueOnce(false)

        const connected = websocketCoordinator.handleConnected(conn.ws, conn.userData)
        resolveAccess({ role: 'user', sessionToken: 'u1' })
        await connected

        expect(sessionExists).toHaveBeenCalledWith('s1', 'u1')
        expect(conn.endedWith).toEqual([4001])
        expect(wsConnectionRegistry.isUserOnline('9110')).toBe(false)
        expect(online.trackConnected).not.toHaveBeenCalled()
    })

    it('closes a connection the logout marked while its reads were awaited', async () => {
        const { wsSessionRevocation } = await import('#app/services/auth/ws-session-revocation.js')
        const conn = connection('9111')

        const connected = websocketCoordinator.handleConnected(conn.ws, conn.userData)
        // The session was still stored when it was read; the logout lands now, finds nothing
        // in the registry to close, and the token stays the same.
        expect(
            wsSessionRevocation.closeUserConnections('9111', { sessionId: sessionIdOf('s1') }),
        ).toBe(0)
        resolveAccess({ role: 'user', sessionToken: 'u1' })
        await connected

        expect(conn.endedWith).toEqual([4001])
        expect(wsConnectionRegistry.isUserOnline('9111')).toBe(false)
    })

    it('keeps a connection of another session of the same user', async () => {
        const { wsSessionRevocation } = await import('#app/services/auth/ws-session-revocation.js')
        const conn = connection('9112')

        const connected = websocketCoordinator.handleConnected(conn.ws, conn.userData)
        wsSessionRevocation.closeUserConnections('9112', {
            sessionId: sessionIdOf('another-session'),
        })
        resolveAccess({ role: 'user', sessionToken: 'u1' })
        await connected

        expect(conn.endedWith).toEqual([])
        expect(wsConnectionRegistry.isUserOnline('9112')).toBe(true)
        await conn.close()
    })

    // Р8: a recovery sign-in marks only the connections being opened with the rotated token.
    it('marks a connection being opened only when its session carries the given token', async () => {
        const { wsSessionRevocation } = await import('#app/services/auth/ws-session-revocation.js')
        const conn = connection('9115')

        const connected = websocketCoordinator.handleConnected(conn.ws, conn.userData)
        expect(
            wsConnectionRegistry.revokeConnecting(
                '9115',
                undefined,
                undefined,
                'other' as SessionToken,
            ),
        ).toBe(0)
        wsSessionRevocation.closeUserConnections('9115', {
            userToken: 'rotated-token' as SessionToken,
        })
        resolveAccess({ role: 'user', sessionToken: 'u1' })
        await connected

        expect(conn.endedWith).toEqual([])
        expect(wsConnectionRegistry.isUserOnline('9115')).toBe(true)

        // Registered now: a close by its own token reaches it.
        expect(
            wsSessionRevocation.closeUserConnections('9115', { userToken: 'u1' as SessionToken }),
        ).toBe(1)
        expect(conn.endedWith).toEqual([4001])
        await conn.close()
    })

    it('forgets the mark once the connection is settled: the next one is not closed by it', async () => {
        const { wsSessionRevocation } = await import('#app/services/auth/ws-session-revocation.js')
        const first = connection('9113')
        const opening = websocketCoordinator.handleConnected(first.ws, first.userData)
        wsSessionRevocation.closeUserConnections('9113')
        resolveAccess({ role: 'user', sessionToken: 'u1' })
        await opening
        expect(first.endedWith).toEqual([4001])

        const second = connection('9113')
        const reopening = websocketCoordinator.handleConnected(second.ws, second.userData)
        resolveAccess({ role: 'user', sessionToken: 'u1' })
        await reopening

        expect(second.endedWith).toEqual([])
        await second.close()
    })

    it('does not register when the session read fails, and leaves no mark behind', async () => {
        const conn = connection('9114')
        sessionExists.mockRejectedValueOnce(new Error('redis down'))

        const connected = websocketCoordinator.handleConnected(conn.ws, conn.userData)
        resolveAccess({ role: 'user', sessionToken: 'u1' })

        await expect(connected).rejects.toThrow('redis down')
        expect(wsConnectionRegistry.isUserOnline('9114')).toBe(false)
        expect(wsConnectionRegistry.revokeConnecting('9114')).toBe(0)
    })
})

describe('user_online rows (feat-124)', () => {
    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

    it('a disconnect before the connect INSERT committed waits for it', async () => {
        const order: string[] = []
        let commit: () => void = () => undefined
        online.trackConnected.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    commit = () => {
                        order.push('inserted')
                        resolve()
                    }
                }),
        )
        online.trackDisconnected.mockImplementationOnce(() => {
            order.push('completed')
            return Promise.resolve()
        })
        const conn = connection('901')
        await connect(conn)

        await conn.close()
        await settle()
        expect(online.trackDisconnected).not.toHaveBeenCalled()

        commit()
        await settle()
        expect(order).toEqual(['inserted', 'completed'])
    })

    // feat-128: a failed INSERT may still have committed (a statement timeout or a reset
    // connection after the COMMIT reached the server); skipping the UPDATE left that row open.
    it('a connect INSERT that failed still gets the disconnect UPDATE', async () => {
        online.trackConnected.mockImplementationOnce(() =>
            Promise.reject(new Error('Connection terminated unexpectedly')),
        )
        const conn = connection('902')
        await connect(conn)

        await conn.close()
        await settle()

        expect(online.trackDisconnected).toHaveBeenCalledTimes(1)
        expect(online.trackDisconnected).toHaveBeenCalledWith(
            expect.objectContaining({ socketUuid: conn.userData.uuid }),
        )
    })

    it('a socket closed while its role was read writes neither row', async () => {
        const conn = connection('903')
        const connected = websocketCoordinator.handleConnected(conn.ws, conn.userData)
        await conn.close()
        resolveRole('user')
        await connected
        await settle()

        expect(online.trackConnected).not.toHaveBeenCalled()
        expect(online.trackDisconnected).not.toHaveBeenCalled()
    })
})

// feat-138 (sixth review L12): the disconnect UPDATEs that closeAllWs starts were not awaited, so
// pool.end() could cut them and leave user_online rows open.
describe('draining the user_online disconnects at shutdown (feat-138)', () => {
    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

    it('waits for a disconnect UPDATE still running', async () => {
        let finish: () => void = () => undefined
        online.trackDisconnected.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    finish = resolve
                }),
        )
        const conn = connection('904')
        await connect(conn)
        await conn.close()
        await settle()

        let drained = false
        const draining = websocketCoordinator.drainDisconnects(1_000).then(() => {
            drained = true
        })
        await settle()
        expect(drained).toBe(false)

        finish()
        await draining
        expect(drained).toBe(true)
    })

    it('gives up at its deadline', async () => {
        online.trackDisconnected.mockImplementationOnce(() => new Promise<void>(() => undefined))
        const conn = connection('905')
        await connect(conn)
        await conn.close()
        await settle()

        await expect(websocketCoordinator.drainDisconnects(20)).resolves.toBe(false)
    })
})

// feat-232 (review 2026-11-19): the client re-reads the profile on `service:connection_ready`.
// It must come only once the socket is in the registry: an event sent before that misses it.
describe('service:connection_ready', () => {
    const readyFrames = (conn: ReturnType<typeof connection>) =>
        conn.sent.filter((frame) => frame.includes('service:connection_ready'))

    it('is sent once the socket is registered, never before', async () => {
        const conn = connection('9201')
        let registeredWhenSent: boolean | undefined
        const send = conn.ws.send.bind(conn.ws)
        ;(conn.ws as unknown as { send: (m: string) => number }).send = (message: string) => {
            if (message.includes('service:connection_ready')) {
                registeredWhenSent =
                    wsConnectionRegistry.getConnection('9201', conn.userData.uuid) === conn.ws
            }
            send(message)
            return 1
        }

        const connected = websocketCoordinator.handleConnected(conn.ws, conn.userData)
        await Promise.resolve()
        // The role and session checks are still running: nothing is ready yet.
        expect(readyFrames(conn)).toEqual([])
        resolveAccess({ role: 'user', sessionToken: 'u1' })
        await connected

        expect(readyFrames(conn)).toHaveLength(1)
        expect(registeredWhenSent).toBe(true)
        expect(JSON.parse(readyFrames(conn)[0]!)).toMatchObject({
            event: 'service:connection_ready',
            data: { socket_id: conn.userData.uuid },
        })
    })

    it('is not sent to a socket closed or revoked while it was checked', async () => {
        const closed = connection('9202')
        const pending = websocketCoordinator.handleConnected(closed.ws, closed.userData)
        await closed.close()
        resolveRole('user')
        await pending

        const revoked = connection('9203')
        const revokedPending = websocketCoordinator.handleConnected(revoked.ws, revoked.userData)
        resolveAccess({ role: 'user', sessionToken: 'rotated' })
        await revokedPending

        expect(readyFrames(closed)).toEqual([])
        expect(readyFrames(revoked)).toEqual([])
    })
})

describe('session list events of the sockets of a session (feat-233, Р12)', () => {
    it('announces the first socket of a session and the close of its last one, nothing between', async () => {
        const first = connection('9301')
        const second = connection('9301')
        await connect(first)
        expect(announceSessionListChanged).toHaveBeenCalledTimes(1)
        expect(announceSessionListChanged).toHaveBeenLastCalledWith('9301')
        expect(touchSessionFromWs).toHaveBeenCalledWith(first.userData)

        await connect(second)
        expect(announceSessionListChanged).toHaveBeenCalledTimes(1)
        expect(wsConnectionRegistry.hasSessionConnection('9301', 's1')).toBe(true)

        await first.close()
        expect(announceSessionListChanged).toHaveBeenCalledTimes(1)
        await second.close()
        expect(announceSessionListChanged).toHaveBeenCalledTimes(2)
        expect(wsConnectionRegistry.hasSessionConnection('9301', 's1')).toBe(false)
    })

    it('a socket of another session of the same user is its own transition', async () => {
        const a = connection('9302')
        const b = connection('9302')
        b.userData.sessionId = 's2'
        await connect(a)
        await connect(b)
        expect(announceSessionListChanged).toHaveBeenCalledTimes(2)
        expect(wsConnectionRegistry.hasSessionConnection('9302', 's2')).toBe(true)
        await b.close()
        expect(announceSessionListChanged).toHaveBeenCalledTimes(3)
        expect(wsConnectionRegistry.hasSessionConnection('9302', 's1')).toBe(true)
        await a.close()
    })

    it('a connection refused at connect announces nothing', async () => {
        const conn = connection('9303')
        const connected = websocketCoordinator.handleConnected(conn.ws, conn.userData)
        resolveAccess({ role: 'user', sessionToken: 'rotated' })
        await connected
        expect(announceSessionListChanged).not.toHaveBeenCalled()
        expect(touchSessionFromWs).not.toHaveBeenCalled()
    })
})
