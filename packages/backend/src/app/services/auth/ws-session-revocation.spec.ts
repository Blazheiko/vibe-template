import type { MyWebSocket } from '#vendor/types/types.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const listConnections = vi.hoisted(() => vi.fn())
const listUserConnections = vi.hoisted(() => vi.fn())
const findSessionTokensByIds = vi.hoisted(() => vi.fn())
const logger = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }))

const revokeConnecting = vi.hoisted(() => vi.fn())
// feat-210: the stored sessions; by default every session asked about is still there.
const sessionsExist = vi.hoisted(() =>
    vi.fn((sessions: readonly unknown[]) => Promise.resolve(sessions.map(() => true))),
)
const sessionExists = vi.hoisted(() => vi.fn(() => Promise.resolve(true)))

vi.mock('#app/websocket/ws-connection-registry.js', () => ({
    wsConnectionRegistry: { listConnections, listUserConnections, revokeConnecting },
}))
vi.mock('#vendor/utils/session/redis-session-storage.js', () => ({ sessionExists, sessionsExist }))
vi.mock('#app/repositories/index.js', () => ({ userRepository: { findSessionTokensByIds } }))
vi.mock('#vendor/utils/logger.js', () => ({ default: logger }))
vi.mock('#config/websocket.js', () => ({ default: { sessionRecheckIntervalMs: 30_000 } }))

const { wsSessionRevocation } = await import('./ws-session-revocation.js')

interface FakeConnection {
    userId: string
    uuid: string
    sessionId: string
    userToken: string | undefined
    ws: MyWebSocket
    send: ReturnType<typeof vi.fn>
    end: ReturnType<typeof vi.fn>
}

const connection = (
    userId: string,
    uuid: string,
    sessionId: string,
    userToken: string | undefined,
): FakeConnection => {
    const send = vi.fn()
    const end = vi.fn()
    const ws = {
        cork: (fn: () => void): void => {
            fn()
        },
        send,
        end,
    } as unknown as MyWebSocket
    return { userId, uuid, sessionId, userToken, ws, send, end }
}

const closedSocket = (target: FakeConnection): void => {
    target.send.mockImplementation(() => {
        throw new Error('Invalid access of closed uWS.WebSocket')
    })
}

beforeEach(() => {
    vi.clearAllMocks()
})
afterEach(() => {
    wsSessionRevocation.stop()
    vi.useRealTimers()
})

describe('closeUserConnections', () => {
    it('closes every connection of the user with 4001, after the session_expired message', () => {
        const first = connection('1', 'a', 's1', 't')
        const second = connection('1', 'b', 's2', 't')
        listUserConnections.mockReturnValue([first, second])

        expect(wsSessionRevocation.closeUserConnections('1')).toBe(2)

        expect(listUserConnections).toHaveBeenCalledWith('1')
        for (const closed of [first, second]) {
            expect(closed.send).toHaveBeenCalledTimes(1)
            expect(JSON.parse(String(closed.send.mock.calls[0]?.[0]))).toMatchObject({
                event: 'service:error',
                error: { code: 'unauthorized' },
            })
            expect(closed.end).toHaveBeenCalledWith(4001)
        }
    })

    it('closes only the connections of the given session', () => {
        const loggedOut = connection('1', 'a', 's1', 't')
        const otherSession = connection('1', 'b', 's2', 't')
        listUserConnections.mockReturnValue([loggedOut, otherSession])

        expect(wsSessionRevocation.closeUserConnections('1', { sessionId: 's1' })).toBe(1)

        expect(loggedOut.end).toHaveBeenCalledWith(4001)
        expect(otherSession.end).not.toHaveBeenCalled()
        expect(otherSession.send).not.toHaveBeenCalled()
    })

    it('skips a connection that has closed already and closes the rest', () => {
        const gone = connection('1', 'a', 's1', 't')
        closedSocket(gone)
        const open = connection('1', 'b', 's1', 't')
        listUserConnections.mockReturnValue([gone, open])

        expect(wsSessionRevocation.closeUserConnections('1')).toBe(1)
        expect(open.end).toHaveBeenCalledWith(4001)
        expect(logger.error).not.toHaveBeenCalled()
    })

    it('logs a connection that could not be closed and still closes the others', () => {
        const broken = connection('1', 'a', 's1', 't')
        broken.end.mockImplementation(() => {
            throw new Error('boom')
        })
        const open = connection('1', 'b', 's1', 't')
        listUserConnections.mockReturnValue([broken, open])

        expect(wsSessionRevocation.closeUserConnections('1')).toBe(1)
        expect(open.end).toHaveBeenCalledWith(4001)
        expect(logger.error).toHaveBeenCalledTimes(1)
    })

    it('never throws: the revocation it follows has been committed', () => {
        listUserConnections.mockImplementation(() => {
            throw new Error('registry broken')
        })

        expect(wsSessionRevocation.closeUserConnections('1')).toBe(0)
        expect(logger.error).toHaveBeenCalledTimes(1)
    })
})

// feat-210: a logout of one session deletes the stored session and rotates nothing.
describe('recheckSessions: stored sessions (feat-210)', () => {
    const tokens = (): void => {
        findSessionTokensByIds.mockResolvedValue(
            new Map([
                ['1', 't1'],
                ['2', 't2'],
            ]),
        )
    }

    it('closes the connections whose stored session is gone and keeps the others', async () => {
        const loggedOut = connection('1', 'a', 's1', 't1')
        const sameSession = connection('1', 'b', 's1', 't1')
        const otherSession = connection('1', 'c', 's2', 't1')
        const otherUser = connection('2', 'd', 's3', 't2')
        listConnections.mockReturnValue([loggedOut, sameSession, otherSession, otherUser])
        tokens()
        sessionsExist.mockResolvedValueOnce([false, true, true])

        const report = await wsSessionRevocation.recheckSessions()

        // One question per session, not per connection.
        expect(sessionsExist).toHaveBeenCalledTimes(1)
        expect(sessionsExist).toHaveBeenCalledWith([
            { sessionId: 's1', userToken: 't1' },
            { sessionId: 's2', userToken: 't1' },
            { sessionId: 's3', userToken: 't2' },
        ])
        expect(report).toEqual({ checked: 4, closed: 2, failed: 0 })
        expect(loggedOut.end).toHaveBeenCalledWith(4001)
        expect(sameSession.end).toHaveBeenCalledWith(4001)
        expect(otherSession.end).not.toHaveBeenCalled()
        expect(otherUser.end).not.toHaveBeenCalled()
    })

    it('does not ask about a connection whose token was rotated: it is closed anyway', async () => {
        const stale = connection('1', 'a', 's1', 'old')
        listConnections.mockReturnValue([stale])
        tokens()

        const report = await wsSessionRevocation.recheckSessions()

        expect(sessionsExist).not.toHaveBeenCalled()
        expect(report).toEqual({ checked: 1, closed: 1, failed: 0 })
    })

    it('closes nothing when Redis does not answer: the next pass decides', async () => {
        const open = connection('1', 'a', 's1', 't1')
        listConnections.mockReturnValue([open])
        tokens()
        sessionsExist.mockRejectedValueOnce(new Error('redis down'))

        await expect(wsSessionRevocation.recheckSessions()).rejects.toThrow('redis down')
        expect(open.end).not.toHaveBeenCalled()
    })
})

describe('closeUserConnections: connections being opened (feat-210)', () => {
    it('marks them before it closes the registered ones, for the session or for the user', () => {
        listUserConnections.mockReturnValue([])

        wsSessionRevocation.closeUserConnections('1', { sessionId: 's1' })
        wsSessionRevocation.closeUserConnections('1')

        expect(revokeConnecting.mock.calls).toEqual([
            ['1', 's1'],
            ['1', undefined],
        ])
        expect(revokeConnecting.mock.invocationCallOrder[0]).toBeLessThan(
            listUserConnections.mock.invocationCallOrder[0] ?? 0,
        )
    })
})

describe('recheckSessions', () => {
    it('makes no query when the instance holds no connection', async () => {
        listConnections.mockReturnValue([])

        await expect(wsSessionRevocation.recheckSessions()).resolves.toEqual({
            checked: 0,
            closed: 0,
            failed: 0,
        })
        expect(findSessionTokensByIds).not.toHaveBeenCalled()
    })

    it('reads the tokens with one query, one id per user, and keeps current connections', async () => {
        const all = [
            connection('1', 'a', 's1', 't1'),
            connection('1', 'b', 's2', 't1'),
            connection('2', 'c', 's3', 't2'),
        ]
        listConnections.mockReturnValue(all)
        findSessionTokensByIds.mockResolvedValue(
            new Map([
                ['1', 't1'],
                ['2', 't2'],
            ]),
        )

        const report = await wsSessionRevocation.recheckSessions()

        expect(findSessionTokensByIds).toHaveBeenCalledTimes(1)
        expect(findSessionTokensByIds).toHaveBeenCalledWith([1n, 2n])
        expect(report).toEqual({ checked: 3, closed: 0, failed: 0 })
        for (const kept of all) expect(kept.end).not.toHaveBeenCalled()
    })

    it('closes every connection opened with a token that has been rotated since', async () => {
        const stale = connection('1', 'a', 's1', 'old')
        const staleToo = connection('1', 'b', 's2', 'old')
        const reconnected = connection('1', 'c', 's3', 'new')
        const other = connection('2', 'd', 's4', 't2')
        listConnections.mockReturnValue([stale, staleToo, reconnected, other])
        findSessionTokensByIds.mockResolvedValue(
            new Map([
                ['1', 'new'],
                ['2', 't2'],
            ]),
        )

        const report = await wsSessionRevocation.recheckSessions()

        expect(report).toEqual({ checked: 4, closed: 2, failed: 0 })
        expect(stale.end).toHaveBeenCalledWith(4001)
        expect(staleToo.end).toHaveBeenCalledWith(4001)
        expect(reconnected.end).not.toHaveBeenCalled()
        expect(other.end).not.toHaveBeenCalled()
    })

    it('closes the connections of a user that no longer exists, and one with no token', async () => {
        const deleted = connection('9', 'a', 's1', 't')
        const tokenless = connection('1', 'b', 's2', undefined)
        listConnections.mockReturnValue([deleted, tokenless])
        findSessionTokensByIds.mockResolvedValue(new Map([['1', 't1']]))

        await expect(wsSessionRevocation.recheckSessions()).resolves.toEqual({
            checked: 2,
            closed: 2,
            failed: 0,
        })
        expect(deleted.end).toHaveBeenCalledWith(4001)
        expect(tokenless.end).toHaveBeenCalledWith(4001)
    })

    it('closes nothing when the database cannot answer', async () => {
        const stale = connection('1', 'a', 's1', 'old')
        listConnections.mockReturnValue([stale])
        findSessionTokensByIds.mockRejectedValue(new Error('timeout'))

        await expect(wsSessionRevocation.recheckSessions()).rejects.toThrow('timeout')
        expect(stale.end).not.toHaveBeenCalled()
    })

    it('counts a connection that could not be closed as failed and closes the others', async () => {
        const broken = connection('1', 'a', 's1', 'old')
        broken.end.mockImplementation(() => {
            throw new Error('boom')
        })
        const gone = connection('1', 'b', 's1', 'old')
        closedSocket(gone)
        const stale = connection('1', 'c', 's1', 'old')
        listConnections.mockReturnValue([broken, gone, stale])
        findSessionTokensByIds.mockResolvedValue(new Map([['1', 'new']]))

        await expect(wsSessionRevocation.recheckSessions()).resolves.toEqual({
            checked: 3,
            closed: 1,
            failed: 1,
        })
        expect(stale.end).toHaveBeenCalledWith(4001)
    })

    it('asks for the tokens in batches of 1000 users', async () => {
        const many = Array.from({ length: 1001 }, (_, i) =>
            connection(String(i + 1), `u${String(i)}`, 's', 't'),
        )
        listConnections.mockReturnValue(many)
        findSessionTokensByIds.mockImplementation((ids: bigint[]) =>
            Promise.resolve(new Map(ids.map((id) => [String(id), 't']))),
        )

        const report = await wsSessionRevocation.recheckSessions()

        expect(findSessionTokensByIds).toHaveBeenCalledTimes(2)
        expect(findSessionTokensByIds.mock.calls[0]?.[0]).toHaveLength(1000)
        expect(findSessionTokensByIds.mock.calls[1]?.[0]).toHaveLength(1)
        expect(report).toEqual({ checked: 1001, closed: 0, failed: 0 })
    })
})

describe('start', () => {
    it('runs a pass every interval and does not stack passes on a slow database', async () => {
        vi.useFakeTimers()
        listConnections.mockReturnValue([connection('1', 'a', 's1', 't')])
        let answer: (tokens: Map<string, string>) => void = () => undefined
        findSessionTokensByIds.mockImplementation(
            () =>
                new Promise<Map<string, string>>((resolve) => {
                    answer = resolve
                }),
        )

        wsSessionRevocation.start(1000)
        await vi.advanceTimersByTimeAsync(3000)
        expect(findSessionTokensByIds).toHaveBeenCalledTimes(1)

        answer(new Map([['1', 't']]))
        await vi.advanceTimersByTimeAsync(1000)
        expect(findSessionTokensByIds).toHaveBeenCalledTimes(2)

        // Let the second pass finish: the "running" flag lives in the module.
        answer(new Map([['1', 't']]))
        await vi.advanceTimersByTimeAsync(0)
    })

    it('logs a failed pass and runs the next one', async () => {
        vi.useFakeTimers()
        listConnections.mockReturnValue([connection('1', 'a', 's1', 't')])
        findSessionTokensByIds.mockRejectedValueOnce(new Error('timeout'))
        findSessionTokensByIds.mockResolvedValue(new Map([['1', 't']]))

        wsSessionRevocation.start(1000)
        await vi.advanceTimersByTimeAsync(2000)

        expect(logger.error).toHaveBeenCalledTimes(1)
        expect(findSessionTokensByIds).toHaveBeenCalledTimes(2)
    })
})
