import type { MyWebSocket } from '#vendor/types/types.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const listConnections = vi.hoisted(() => vi.fn())
const findRolesByIds = vi.hoisted(() => vi.fn())
const logger = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }))

vi.mock('#app/websocket/ws-connection-registry.js', () => ({
    wsConnectionRegistry: { listConnections },
}))
vi.mock('#app/repositories/index.js', () => ({ userRepository: { findRolesByIds } }))
vi.mock('#vendor/utils/logger.js', () => ({ default: logger }))
vi.mock('#config/websocket.js', () => ({ default: { adminRecheckIntervalMs: 30_000 } }))

const { adminWsAccessService } = await import('./admin-ws-access-service.js')

interface FakeConnection {
    userId: string
    uuid: string
    ws: MyWebSocket
    userData: { role: 'user' | 'admin' | undefined; isAdminChannelSubscribed: boolean }
    unsubscribe: ReturnType<typeof vi.fn>
}

const connection = (
    userId: string,
    uuid: string,
    role: 'user' | 'admin' | undefined,
    subscribed = true,
): FakeConnection => {
    const userData = { role, isAdminChannelSubscribed: subscribed }
    const unsubscribe = vi.fn()
    const ws = {
        getUserData: () => userData,
        subscribe: vi.fn(),
        unsubscribe,
    } as unknown as MyWebSocket
    return { userId, uuid, ws, userData, unsubscribe }
}

beforeEach(() => {
    vi.clearAllMocks()
})
afterEach(() => {
    adminWsAccessService.stop()
    vi.useRealTimers()
})

describe('recheckAdminConnections', () => {
    it('makes no query when no connection holds the admin role', async () => {
        listConnections.mockReturnValue([
            connection('1', 'a', 'user'),
            connection('2', 'b', undefined),
        ])

        await expect(adminWsAccessService.recheckAdminConnections()).resolves.toEqual({
            checked: 0,
            revoked: 0,
        })
        expect(findRolesByIds).not.toHaveBeenCalled()
    })

    it('reads the roles of the admin connections with one query, one id per user', async () => {
        listConnections.mockReturnValue([
            connection('1', 'a', 'admin'),
            connection('1', 'b', 'admin'),
            connection('2', 'c', 'admin'),
            connection('3', 'd', 'user'),
        ])
        findRolesByIds.mockResolvedValue(
            new Map([
                ['1', 'admin'],
                ['2', 'admin'],
            ]),
        )

        const report = await adminWsAccessService.recheckAdminConnections()

        expect(findRolesByIds).toHaveBeenCalledTimes(1)
        expect(findRolesByIds).toHaveBeenCalledWith([1n, 2n])
        expect(report).toEqual({ checked: 3, revoked: 0 })
    })

    it('takes the admin channel and the role from a demoted user, on every connection', async () => {
        const first = connection('1', 'a', 'admin')
        const second = connection('1', 'b', 'admin')
        const staying = connection('2', 'c', 'admin')
        listConnections.mockReturnValue([first, second, staying])
        findRolesByIds.mockResolvedValue(
            new Map([
                ['1', 'user'],
                ['2', 'admin'],
            ]),
        )

        const report = await adminWsAccessService.recheckAdminConnections()

        expect(report).toEqual({ checked: 3, revoked: 2 })
        for (const demoted of [first, second]) {
            expect(demoted.unsubscribe).toHaveBeenCalledWith('admin')
            expect(demoted.userData.isAdminChannelSubscribed).toBe(false)
            expect(demoted.userData.role).toBe('user')
        }
        expect(staying.unsubscribe).not.toHaveBeenCalled()
        expect(staying.userData.role).toBe('admin')
        expect(logger.warn).toHaveBeenCalledTimes(2)
    })

    it('treats a user that no longer exists as no longer an admin', async () => {
        const gone = connection('9', 'a', 'admin')
        listConnections.mockReturnValue([gone])
        findRolesByIds.mockResolvedValue(new Map())

        await expect(adminWsAccessService.recheckAdminConnections()).resolves.toEqual({
            checked: 1,
            revoked: 1,
        })
        expect(gone.userData.role).toBe('user')
    })

    it('revokes the role of an admin connection that never subscribed', async () => {
        const idle = connection('1', 'a', 'admin', false)
        listConnections.mockReturnValue([idle])
        findRolesByIds.mockResolvedValue(new Map([['1', 'user']]))

        await adminWsAccessService.recheckAdminConnections()

        // The admin WS routes read this role: it has to drop even without a subscription.
        expect(idle.userData.role).toBe('user')
        expect(idle.unsubscribe).not.toHaveBeenCalled()
    })

    it('skips a connection that closed while the query ran', async () => {
        const closing = connection('1', 'a', 'admin')
        closing.unsubscribe.mockImplementation(() => {
            throw new Error('Invalid access of closed uWS.WebSocket')
        })
        const open = connection('2', 'b', 'admin')
        listConnections.mockReturnValue([closing, open])
        findRolesByIds.mockResolvedValue(
            new Map([
                ['1', 'user'],
                ['2', 'user'],
            ]),
        )

        const report = await adminWsAccessService.recheckAdminConnections()

        expect(report).toEqual({ checked: 2, revoked: 1 })
        expect(open.userData.role).toBe('user')
    })

    it('skips a connection that is already closed when the snapshot is taken', async () => {
        const closed = connection('1', 'a', 'admin')
        closed.ws.getUserData = () => {
            throw new Error('Invalid access of closed uWS.WebSocket')
        }
        listConnections.mockReturnValue([closed])

        await expect(adminWsAccessService.recheckAdminConnections()).resolves.toEqual({
            checked: 0,
            revoked: 0,
        })
    })

    it('changes nothing and rethrows when the database cannot answer', async () => {
        const admin = connection('1', 'a', 'admin')
        listConnections.mockReturnValue([admin])
        findRolesByIds.mockRejectedValue(new Error('connection terminated'))

        await expect(adminWsAccessService.recheckAdminConnections()).rejects.toThrow(
            'connection terminated',
        )
        expect(admin.userData.role).toBe('admin')
        expect(admin.unsubscribe).not.toHaveBeenCalled()
    })
})

describe('start / stop', () => {
    beforeEach(() => {
        vi.useFakeTimers()
    })

    it('re-checks on every interval and stops on stop()', async () => {
        listConnections.mockReturnValue([])
        const spy = vi.spyOn(adminWsAccessService, 'recheckAdminConnections')

        adminWsAccessService.start(1000)
        await vi.advanceTimersByTimeAsync(3000)
        expect(spy).toHaveBeenCalledTimes(3)

        adminWsAccessService.stop()
        await vi.advanceTimersByTimeAsync(3000)
        expect(spy).toHaveBeenCalledTimes(3)
        spy.mockRestore()
    })

    it('start() twice runs one timer', async () => {
        listConnections.mockReturnValue([])
        const spy = vi.spyOn(adminWsAccessService, 'recheckAdminConnections')

        adminWsAccessService.start(1000)
        adminWsAccessService.start(1000)
        await vi.advanceTimersByTimeAsync(1000)

        expect(spy).toHaveBeenCalledTimes(1)
        spy.mockRestore()
    })

    it('does not stack passes while the previous one is still running', async () => {
        let finish: () => void = () => undefined
        const spy = vi.spyOn(adminWsAccessService, 'recheckAdminConnections').mockReturnValue(
            new Promise((resolve) => {
                finish = () => {
                    resolve({ checked: 0, revoked: 0 })
                }
            }),
        )

        adminWsAccessService.start(1000)
        await vi.advanceTimersByTimeAsync(5000)
        expect(spy).toHaveBeenCalledTimes(1)

        finish()
        await vi.advanceTimersByTimeAsync(1000)
        expect(spy).toHaveBeenCalledTimes(2)
        spy.mockRestore()
    })

    it('logs a failed pass and keeps going', async () => {
        const spy = vi
            .spyOn(adminWsAccessService, 'recheckAdminConnections')
            .mockRejectedValueOnce(new Error('connection terminated'))
            .mockResolvedValue({ checked: 0, revoked: 0 })

        adminWsAccessService.start(1000)
        await vi.advanceTimersByTimeAsync(2000)

        expect(logger.error).toHaveBeenCalledTimes(1)
        expect(spy).toHaveBeenCalledTimes(2)
        spy.mockRestore()
    })
})
