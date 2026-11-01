import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The lease when Redis stops answering: the holder must learn that it lost the lock BEFORE
// the key can expire and a second answer start. Real-Redis behaviour is in
// support-inflight-lock.redis.test.ts.

const redisMock = { set: vi.fn(), eval: vi.fn() }

vi.mock('#database/redis.js', () => ({
    default: redisMock,
    withRedis: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}))

const lease = { ttlMs: 4_000, renewEveryMs: 1_000, maxLifetimeMs: 60_000 }

async function acquire() {
    const { acquireSupportLock } = await import('./support-inflight-lock.js')
    redisMock.set.mockResolvedValue('OK')
    return acquireSupportLock(1n, lease)
}

beforeEach(() => {
    vi.useFakeTimers()
})

afterEach(() => {
    vi.useRealTimers()
    vi.resetModules()
    vi.clearAllMocks()
})

describe('support in-flight lease', () => {
    it('renews every renewEveryMs while Redis answers', async () => {
        redisMock.eval.mockResolvedValue(1)
        const lock = await acquire()

        await vi.advanceTimersByTimeAsync(3_500)

        expect(redisMock.eval).toHaveBeenCalledTimes(3)
        expect(lock?.lost.aborted).toBe(false)
    })

    it('survives one failed renewal', async () => {
        redisMock.eval.mockRejectedValueOnce(new Error('Command timed out')).mockResolvedValue(1)
        const lock = await acquire()

        await vi.advanceTimersByTimeAsync(3_500)

        expect(lock?.lost.aborted).toBe(false)
    })

    it('is lost before the key can expire when Redis stays silent', async () => {
        redisMock.eval.mockRejectedValue(new Error('Command timed out'))
        const lock = await acquire()

        await vi.advanceTimersByTimeAsync(2_500)
        expect(lock?.lost.aborted).toBe(false)
        await vi.advanceTimersByTimeAsync(1_000)
        // 3 s after the last good renewal: one renewal interval before the 4 s TTL ends.
        expect(lock?.lost.aborted).toBe(true)
    })

    it('is lost even when a renewal never returns', async () => {
        redisMock.eval.mockReturnValue(new Promise(() => undefined))
        const lock = await acquire()

        await vi.advanceTimersByTimeAsync(3_100)

        expect(lock?.lost.aborted).toBe(true)
    })

    it('does not mistake a renewal that returned late for a lost lease', async () => {
        let answer: (value: number) => void = () => undefined
        redisMock.eval.mockImplementationOnce(
            () => new Promise<number>((resolve) => (answer = resolve)),
        )
        redisMock.eval.mockResolvedValue(1)
        const lock = await acquire()

        await vi.advanceTimersByTimeAsync(1_500)
        answer(1)
        await vi.advanceTimersByTimeAsync(3_000)

        expect(lock?.lost.aborted).toBe(false)
    })
})
