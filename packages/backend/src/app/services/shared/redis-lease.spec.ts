import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// feat-222: the lease methods the scheduler needs (abandon, checkpoint, evalAsOwner) on a mocked
// Redis and fake timers. Real-Redis behaviour is in redis-lease.redis.test.ts.

const redisMock = { set: vi.fn(), eval: vi.fn() }

vi.mock('#database/redis.js', () => ({
    default: redisMock,
    withRedis: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}))

class LostError extends Error {}

const lease = { ttlMs: 4_000, renewEveryMs: 1_000, maxLifetimeMs: 60_000 }

async function acquire() {
    const { acquireLease } = await import('./redis-lease.js')
    redisMock.set.mockResolvedValue('OK')
    const held = await acquireLease('k', lease, (reason) => new LostError(reason))
    if (held === null) throw new Error('not acquired')
    return held
}

// A blocked event loop: the monotonic clock moves on, but no timer callback runs. The fake
// performance.now() only moves with the timers, so a shift is added on top of it.
let blockedFor = 0
const busyWait = (ms: number): void => {
    blockedFor += ms
}

beforeEach(() => {
    vi.useFakeTimers({
        toFake: [
            'setTimeout',
            'clearTimeout',
            'setInterval',
            'clearInterval',
            'Date',
            'performance',
        ],
    })
    blockedFor = 0
    const fakeNow = performance.now.bind(performance)
    vi.spyOn(performance, 'now').mockImplementation(() => fakeNow() + blockedFor)
})

afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
    vi.resetModules()
    vi.clearAllMocks()
})

describe('HeldLease.checkpoint', () => {
    it('does not throw before the local deadline', async () => {
        redisMock.eval.mockRejectedValue(new Error('Command timed out'))
        const held = await acquire()

        busyWait(2_900)

        expect(() => {
            held.checkpoint()
        }).not.toThrow()
    })

    // Lost at ttl - renewEvery = 3 s. The event loop is blocked past it: the deadline timer has
    // not run, `lost` is not aborted yet, but checkpoint() must already refuse the next step.
    it('throws once the deadline has passed, before the deadline timer has run', async () => {
        redisMock.eval.mockRejectedValue(new Error('Command timed out'))
        const held = await acquire()

        busyWait(3_100)
        expect(held.lost.aborted).toBe(false)

        expect(() => {
            held.checkpoint()
        }).toThrow(LostError)
        expect(held.lost.aborted).toBe(true)
        expect((held.lost.reason as Error).message).toBe('the local deadline passed')
    })

    it('throws the reason of a lease already lost', async () => {
        redisMock.eval.mockResolvedValue(0)
        const held = await acquire()

        await vi.advanceTimersByTimeAsync(1_000)

        expect(held.lost.aborted).toBe(true)
        expect(() => {
            held.checkpoint()
        }).toThrow('the key is gone or belongs to another holder')
    })

    it('follows a renewal: the deadline moves with it', async () => {
        redisMock.eval.mockResolvedValue(1)
        const held = await acquire()

        await vi.advanceTimersByTimeAsync(2_500)
        busyWait(2_000)

        // 4.5 s after the start but 2.5 s after the last renewal (at 2 s): still ours.
        expect(() => {
            held.checkpoint()
        }).not.toThrow()
    })
})

describe('HeldLease.abandon', () => {
    it('stops renewals and the deadline, and leaves the key alone', async () => {
        redisMock.eval.mockResolvedValue(1)
        const held = await acquire()

        held.abandon()
        await vi.advanceTimersByTimeAsync(10_000)

        expect(redisMock.eval).not.toHaveBeenCalled()
        expect(held.lost.aborted).toBe(false)
    })

    it('makes a later release a no-op that does not reach Redis', async () => {
        const held = await acquire()

        held.abandon()

        expect(await held.release()).toBe(false)
        expect(redisMock.eval).not.toHaveBeenCalled()
    })

    it('a release that failed can be tried again', async () => {
        const held = await acquire()
        redisMock.eval.mockRejectedValueOnce(new Error('Connection is closed'))

        await expect(held.release()).rejects.toThrow('Connection is closed')
        redisMock.eval.mockResolvedValueOnce(1)

        expect(await held.release()).toBe(true)
        expect(redisMock.eval).toHaveBeenCalledTimes(2)
    })

    it('a second release does not reach Redis', async () => {
        redisMock.eval.mockResolvedValue(1)
        const held = await acquire()

        expect(await held.release()).toBe(true)
        expect(await held.release()).toBe(false)
        expect(redisMock.eval).toHaveBeenCalledTimes(1)
    })
})

describe('HeldLease.evalAsOwner', () => {
    it('prefixes the owner check and passes the lease key and token first', async () => {
        redisMock.eval.mockResolvedValue('done')
        const held = await acquire()
        const token = redisMock.set.mock.calls[0]?.[1] as string

        const reply = await held.evalAsOwner("return 'done'", ['state'], ['a', 7])

        expect(reply).toBe('done')
        const [script, numKeys, ...rest] = redisMock.eval.mock.calls[0] as unknown[]
        expect(String(script)).toMatch(
            /^if redis\.call\('GET', KEYS\[1\]\) ~= ARGV\[1\] then return 'not-owner' end\n/,
        )
        expect(String(script).endsWith("return 'done'")).toBe(true)
        expect(numKeys).toBe(2)
        expect(rest).toEqual(['k', 'state', token, 'a', '7'])
    })
})
