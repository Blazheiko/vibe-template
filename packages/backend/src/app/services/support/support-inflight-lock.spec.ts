import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupportLease } from './support-inflight-lock.js'

// The lease when Redis stops answering: the holder must learn that it lost the lock BEFORE
// the key can expire and a second answer start. Real-Redis behaviour is in
// support-inflight-lock.redis.test.ts.

const redisMock = { set: vi.fn(), eval: vi.fn() }

vi.mock('#database/redis.js', () => ({
    default: redisMock,
    withRedis: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}))

const lease = { ttlMs: 4_000, renewEveryMs: 1_000, maxLifetimeMs: 60_000 }

async function acquire(with_: SupportLease = lease) {
    const { acquireSupportLock } = await import('./support-inflight-lock.js')
    redisMock.set.mockResolvedValue('OK')
    return acquireSupportLock(1n, with_)
}

beforeEach(() => {
    // feat-122: the lease runs on performance.now(); it is faked with the timers.
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

    // feat-122 (L6): the deadline is its own timer. TTL 3.5 s, renewals every 1 s: lost at 2.5 s.
    // On the renewal tick alone it would only be seen at 3 s, and with a late tick after the key
    // had expired.
    it('is lost exactly one interval before the key can expire, between renewal ticks', async () => {
        redisMock.eval.mockRejectedValue(new Error('Command timed out'))
        const lock = await acquire({ ttlMs: 3_500, renewEveryMs: 1_000, maxLifetimeMs: 60_000 })

        await vi.advanceTimersByTimeAsync(2_400)
        expect(lock?.lost.aborted).toBe(false)
        await vi.advanceTimersByTimeAsync(150)
        expect(lock?.lost.aborted).toBe(true)
    })

    it('measures the deadline from the start of the renewal that extended the key', async () => {
        let answer: (value: number) => void = () => undefined
        redisMock.eval
            .mockImplementationOnce(() => new Promise<number>((resolve) => (answer = resolve)))
            .mockRejectedValue(new Error('Command timed out'))
        const lock = await acquire()

        // Sent at 1 s, answered at 1.9 s: the key lives at least until 1 s + 4 s, so the lease
        // is lost at 4 s, not at 4.9 s.
        await vi.advanceTimersByTimeAsync(1_900)
        answer(1)
        await vi.advanceTimersByTimeAsync(2_050)
        expect(lock?.lost.aborted).toBe(false)
        await vi.advanceTimersByTimeAsync(100)
        expect(lock?.lost.aborted).toBe(true)
    })

    it('stops renewing once released', async () => {
        redisMock.eval.mockResolvedValue(1)
        const lock = await acquire()
        await lock?.release()
        redisMock.eval.mockClear()

        await vi.advanceTimersByTimeAsync(10_000)

        expect(redisMock.eval).not.toHaveBeenCalled()
        expect(lock?.lost.aborted).toBe(false)
    })
})

// feat-130 (fifth review): a renewal sent before release() answers after it; it used to re-arm the
// deadline, and the released lease later reported a false "lost".
describe('a released lease', () => {
    it('is never reported lost by a renewal that answers after the release', async () => {
        let answerRenewal: (value: number) => void = () => undefined
        redisMock.eval.mockImplementationOnce(
            () =>
                new Promise<number>((resolve) => {
                    answerRenewal = resolve
                }),
        )
        const lock = await acquire()
        await vi.advanceTimersByTimeAsync(1_000) // the renewal is sent and waits

        redisMock.eval.mockResolvedValue(1) // RELEASE_LUA
        await lock?.release()
        answerRenewal(1)
        await vi.advanceTimersByTimeAsync(60_000)

        expect(lock?.lost.aborted).toBe(false)
    })
})

// feat-135 (sixth review L4): the lease was told lost only one renewal interval (5 s support,
// 10 s KB) before the key could expire, while a database write started just before can run for
// DB_QUERY_TIMEOUT_MS + the connect wait. `stopBeforeExpiryMs` widens that margin.
describe('a lease that must outlast the longest write', () => {
    it('is lost stopBeforeExpiryMs before the key can expire, not one renewal interval', async () => {
        redisMock.eval.mockRejectedValue(new Error('Command timed out'))
        const lock = await acquire({ ...lease, stopBeforeExpiryMs: 2_500 })

        await vi.advanceTimersByTimeAsync(1_400)
        expect(lock?.lost.aborted).toBe(false)
        await vi.advanceTimersByTimeAsync(200)
        // 4 s TTL - 2.5 s margin: lost 1.5 s after the last good extension (it was 3 s).
        expect(lock?.lost.aborted).toBe(true)
    })

    it('leaseForDatabaseWrites keeps a margin of the longest write and room to renew', async () => {
        const { leaseForDatabaseWrites, DATABASE_WRITE_BOUND_MS } =
            await import('#app/services/shared/redis-lease.js')
        const derived = leaseForDatabaseWrites({
            ttlMs: 30_000,
            renewEveryMs: 10_000,
            maxLifetimeMs: 60_000,
        })

        expect(derived.stopBeforeExpiryMs).toBeGreaterThan(DATABASE_WRITE_BOUND_MS)
        expect(derived.ttlMs - (derived.stopBeforeExpiryMs ?? 0)).toBeGreaterThanOrEqual(
            2 * derived.renewEveryMs,
        )
    })
})
