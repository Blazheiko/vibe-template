import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RedisUnavailableError } from '#vendor/utils/network/errors/redis-unavailable-error.js'

const logger = vi.hoisted(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
}))
vi.mock('#vendor/utils/logger.js', () => ({ default: logger }))
vi.mock('#config/redis.js', () => ({
    default: {
        keyPrefix: 'test:',
        commandTimeoutMs: 500,
        logoutAllDeadlineMs: 2000,
    },
}))

const redis = vi.hoisted(() => ({
    get: vi.fn(),
    getex: vi.fn(),
    setex: vi.fn(),
    del: vi.fn(),
    scan: vi.fn(),
    multi: vi.fn(),
    eval: vi.fn(),
}))
// The real classification is covered in redis-health.spec.ts; here withRedis
// only has to turn a failure into RedisUnavailableError like the real one.
const withRedis = vi.hoisted(() => vi.fn(async <T>(op: () => Promise<T>): Promise<T> => op()))
vi.mock('#database/redis.js', () => ({ default: redis, withRedis }))

const storage = await import('./redis-session-storage.js')

const USER_TOKEN = 'abcdef0123456789abcdef0123456789'
const SESSION = {
    id: 's1',
    data: { userToken: USER_TOKEN, csrfToken: 'c' },
    createdAt: '2026-10-21T00:00:00.000Z',
}

beforeEach(() => {
    vi.clearAllMocks()
    withRedis.mockImplementation(async (op) => op())
})
afterEach(() => {
    vi.useRealTimers()
})

describe('session operations go through withRedis', () => {
    it.each([
        ['getSession', () => storage.getSession('s1', USER_TOKEN)],
        ['saveSession', () => storage.saveSession(SESSION)],
        ['destroySession', () => storage.destroySession('s1', USER_TOKEN)],
        ['changeSessionData', () => storage.changeSessionData('s1', { a: 1 }, USER_TOKEN)],
    ])('%s rejects with RedisUnavailableError when Redis is down', async (_, call) => {
        withRedis.mockRejectedValue(new RedisUnavailableError())
        await expect(call()).rejects.toBeInstanceOf(RedisUnavailableError)
    })
})

describe('updateSessionData', () => {
    // feat-111: compare-and-set over the record read, never a plain SETEX.
    it('writes the merged session only over the record it read', async () => {
        const current = JSON.stringify(SESSION)
        redis.get.mockResolvedValue(current)
        redis.eval.mockResolvedValue(1)

        const updated = await storage.updateSessionData('s1', { csrfToken: 'next' }, USER_TOKEN)

        expect(updated?.data).toMatchObject({ userToken: USER_TOKEN, csrfToken: 'next' })
        const [, keys, key, expected, written] = redis.eval.mock.calls[0] as unknown[]
        expect(keys).toBe(1)
        expect(key).toBe(`session:${USER_TOKEN}:s1`)
        expect(expected).toBe(current)
        expect(
            (JSON.parse(String(written)) as { data: Record<string, unknown> }).data,
        ).toMatchObject({ csrfToken: 'next' })
        expect(redis.setex).not.toHaveBeenCalled()
    })

    it('answers null and writes nothing when the record is gone', async () => {
        redis.get.mockResolvedValue(null)

        expect(await storage.updateSessionData('s1', { csrfToken: 'next' }, USER_TOKEN)).toBeNull()
        expect(redis.eval).not.toHaveBeenCalled()
        expect(redis.setex).not.toHaveBeenCalled()
    })

    it('answers null when the record vanished between the read and the write', async () => {
        redis.get.mockResolvedValue(JSON.stringify(SESSION))
        redis.eval.mockResolvedValue(-1)

        expect(await storage.updateSessionData('s1', { csrfToken: 'next' }, USER_TOKEN)).toBeNull()
    })

    it('applies the change again to a record another request changed meanwhile', async () => {
        const first = JSON.stringify(SESSION)
        const second = JSON.stringify({ ...SESSION, data: { ...SESSION.data, other: 'kept' } })
        redis.get.mockResolvedValueOnce(first).mockResolvedValueOnce(second)
        redis.eval.mockResolvedValueOnce(0).mockResolvedValueOnce(1)

        const updated = await storage.updateSessionData('s1', { csrfToken: 'next' }, USER_TOKEN)

        expect(redis.eval).toHaveBeenCalledTimes(2)
        expect(redis.eval.mock.calls[1]?.[3]).toBe(second)
        expect(updated?.data).toMatchObject({ other: 'kept', csrfToken: 'next' })
    })

    it('gives up after three conflicts', async () => {
        redis.get.mockResolvedValue(JSON.stringify(SESSION))
        redis.eval.mockResolvedValue(0)

        await expect(
            storage.updateSessionData('s1', { csrfToken: 'next' }, USER_TOKEN),
        ).rejects.toBeInstanceOf(storage.SessionUpdateConflictError)
        expect(redis.eval).toHaveBeenCalledTimes(3)
    })

    it('does not write when the read fails with RedisUnavailableError', async () => {
        withRedis.mockRejectedValueOnce(new RedisUnavailableError())

        await expect(
            storage.updateSessionData('s1', { csrfToken: 'next' }, USER_TOKEN),
        ).rejects.toBeInstanceOf(RedisUnavailableError)
        expect(withRedis).toHaveBeenCalledTimes(1)
        expect(redis.setex).not.toHaveBeenCalled()
    })
})

/**
 * A tiny keyspace for SCAN: `foreign` keys of other users interleaved with the
 * user's sessions, 10 keys per SCAN call, cursor = index of the next key.
 */
const createKeyspace = (sessionIds: string[], foreign = 0) => {
    const keys: string[] = []
    for (let i = 0; i < foreign; i++) keys.push(`session:other${String(i)}:x`)
    sessionIds.forEach((id, n) => {
        keys.splice(
            Math.floor(((n + 1) * keys.length) / (sessionIds.length + 1)),
            0,
            `session:${USER_TOKEN}:${id}`,
        )
    })
    const live = new Set(keys)
    const scanCursors: string[] = []
    redis.scan.mockImplementation(async (cursor: string, _m: string, pattern: string) => {
        scanCursors.push(cursor)
        const start = Number(cursor)
        const batch = keys.slice(start, start + 10)
        const next = start + 10 >= keys.length ? '0' : String(start + 10)
        const match = pattern.slice(0, -1) // "test:session:<token>:"
        return [
            next,
            batch
                .filter((k) => live.has(k))
                .map((k) => `test:${k}`)
                .filter((k) => k.startsWith(match)),
        ]
    })
    redis.del.mockImplementation(async (...del: string[]) => {
        let n = 0
        for (const k of del) if (live.delete(k)) n++
        return n
    })
    return {
        scanCursors,
        sessions: () => [...live].filter((k) => k.startsWith(`session:${USER_TOKEN}:`)),
        foreign: () => [...live].filter((k) => !k.startsWith(`session:${USER_TOKEN}:`)),
    }
}

/** Lets `ok` withRedis calls through, then fails every later one. */
const failAfter = (ok: number): void => {
    let calls = 0
    withRedis.mockImplementation(async (op) => {
        calls += 1
        if (calls > ok) throw new RedisUnavailableError()
        return op()
    })
}

describe('destroyAllSessions', () => {
    it('deletes every session of the user after a full SCAN from 0, nothing of other users', async () => {
        const ks = createKeyspace(['a', 'b', 'current', 'c'], 25)

        await expect(storage.destroyAllSessions(USER_TOKEN)).resolves.toEqual({
            deleted: 4,
            complete: true,
        })

        expect(ks.sessions()).toEqual([])
        expect(ks.foreign()).toHaveLength(25)
        expect(ks.scanCursors[0]).toBe('0')
        // No retry cursor is read or written any more.
        expect(redis.get).not.toHaveBeenCalled()
        expect(redis.setex).not.toHaveBeenCalled()
        expect(redis.multi).not.toHaveBeenCalled()
    })

    it('a run stopped by Redis resolves with the confirmed deletions and complete: false', async () => {
        const ks = createKeyspace(['a', 'b', 'c', 'd'], 40) // a session at 8, 16, 24, 32: one per SCAN page
        failAfter(4) // scan, del, scan, del: two pages done, the third SCAN fails

        await expect(storage.destroyAllSessions(USER_TOKEN)).resolves.toEqual({
            deleted: 2,
            complete: false,
        })
        expect(ks.sessions()).toHaveLength(2)
        expect(logger.warn).toHaveBeenCalledWith(
            expect.objectContaining({ deleted: 2 }),
            expect.stringContaining('Stopped deleting all sessions'),
        )
        expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(USER_TOKEN)
    })

    it('a failing first SCAN resolves with nothing deleted and complete: false', async () => {
        const ks = createKeyspace(['a', 'b'], 5)
        failAfter(0)

        await expect(storage.destroyAllSessions(USER_TOKEN)).resolves.toEqual({
            deleted: 0,
            complete: false,
        })
        expect(ks.sessions()).toHaveLength(2)
    })

    it('a repeat after a stop scans from 0 again and deletes the rest', async () => {
        const ks = createKeyspace(['a', 'b', 'c', 'd'], 40)
        failAfter(4)
        await storage.destroyAllSessions(USER_TOKEN)

        withRedis.mockImplementation(async (op) => op())
        ks.scanCursors.length = 0
        await expect(storage.destroyAllSessions(USER_TOKEN)).resolves.toEqual({
            deleted: 2,
            complete: true,
        })
        expect(ks.scanCursors[0]).toBe('0')
        expect(ks.sessions()).toEqual([])
    })

    it('rethrows an error that is not Redis being unavailable (a bug)', async () => {
        createKeyspace(['a'])
        const bug = new TypeError('bug')
        redis.del.mockRejectedValue(bug)

        await expect(storage.destroyAllSessions(USER_TOKEN)).rejects.toBe(bug)
        expect(logger.warn).not.toHaveBeenCalled()
    })

    it('gives up at the deadline, not deadline + command timeout', async () => {
        vi.useFakeTimers()
        const start = Date.now()
        const scanAfter = (ms: number) => () =>
            new Promise((resolve) =>
                setTimeout(() => {
                    resolve(['7', []])
                }, ms),
            )
        // Four 490 ms SCANs and one of 30 ms: the next command starts at 1990 ms,
        // 10 ms before the 2000 ms deadline, and hangs.
        for (const ms of [490, 490, 490, 490, 30]) {
            redis.scan.mockImplementationOnce(scanAfter(ms))
        }
        redis.scan.mockImplementationOnce(() => new Promise(() => {}))

        let settledAt = 0
        const result = storage.destroyAllSessions(USER_TOKEN).then((outcome) => {
            settledAt = Date.now()
            return outcome
        })
        await vi.advanceTimersByTimeAsync(3_000)

        expect(await result).toEqual({ deleted: 0, complete: false })
        expect(redis.scan).toHaveBeenCalledTimes(6)
        // Not 1990 + 500 (the command timeout): the remaining 10 ms only.
        expect(settledAt - start).toBe(2_000)
    })
})
