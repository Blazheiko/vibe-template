import { describe, expect, it, vi } from 'vitest'
import { ms, seconds } from 'shared/brand'

vi.mock('#vendor/utils/logger.js', () => ({
    default: { debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

import { createRateLimitStore, retryAfterSeconds } from './rate-limit-store.js'

const clock = (start = 1_000_000) => {
    let time = start
    return {
        now: () => time,
        advance: (ms: number) => {
            time += ms
        },
    }
}

const SLIDING = { windowMs: 1_000, max: 3 } as const
const FIXED = { windowMs: 1_000, max: 3, algorithm: 'fixed-window' } as const

describe('sliding log', () => {
    it('allows max attempts and rejects the next one', () => {
        const store = createRateLimitStore({ now: clock().now })
        const results = Array.from({ length: 4 }, () => store.consume('k', SLIDING))
        expect(results.map((r) => r.allowed)).toEqual([true, true, true, false])
        expect(results[2]).toMatchObject({ remaining: 0, limit: 3 })
    })

    it('does not grow its state on rejected attempts', () => {
        const c = clock()
        const store = createRateLimitStore({ now: c.now })
        for (let i = 0; i < 3; i++) store.consume('k', SLIDING)
        let last = store.consume('k', SLIDING)
        for (let i = 0; i < 1000; i++) last = store.consume('k', SLIDING)
        // Still blocked by the first allowed attempt: rejections were not recorded.
        expect(last).toMatchObject({ allowed: false, retryAfterMs: 1_000 })
    })

    it('recovers exactly at Retry-After after a series of rejections', () => {
        const c = clock()
        const store = createRateLimitStore({ now: c.now })
        store.consume('k', SLIDING)
        c.advance(100)
        store.consume('k', SLIDING)
        store.consume('k', SLIDING)
        let rejected = store.consume('k', SLIDING)
        for (let i = 0; i < 50; i++) {
            c.advance(10)
            rejected = store.consume('k', SLIDING)
        }
        expect(rejected.allowed).toBe(false)
        if (rejected.allowed) return

        c.advance(rejected.retryAfterMs - 1)
        expect(store.consume('k', SLIDING).allowed).toBe(false)
        c.advance(1)
        expect(store.consume('k', SLIDING).allowed).toBe(true)
    })

    it('is disabled by max = 0 and keeps no state', () => {
        const store = createRateLimitStore()
        for (let i = 0; i < 10; i++) {
            expect(store.consume('k', { windowMs: 1_000, max: 0 }).allowed).toBe(true)
        }
        expect(store.size).toBe(0)
    })
})

describe('fixed window', () => {
    it('resets at the window boundary with an exact Retry-After', () => {
        const c = clock()
        const store = createRateLimitStore({ now: c.now })
        for (let i = 0; i < 3; i++) store.consume('k', FIXED)
        c.advance(400)
        const rejected = store.consume('k', FIXED)
        expect(rejected).toMatchObject({ allowed: false, retryAfterMs: 600 })

        c.advance(599)
        expect(store.consume('k', FIXED).allowed).toBe(false)
        c.advance(1)
        expect(store.consume('k', FIXED)).toMatchObject({
            allowed: true,
            remaining: 2,
        })
    })
})

describe('key bound', () => {
    it('never exceeds maxKeys and drops expired keys first', () => {
        const c = clock()
        const store = createRateLimitStore({ maxKeys: 4, now: c.now })
        store.consume('old', SLIDING)
        c.advance(2_000) // "old" is expired now
        for (const key of ['a', 'b', 'c']) store.consume(key, SLIDING)
        expect(store.size).toBe(4)

        store.consume('d', SLIDING)
        expect(store.size).toBe(4)
        expect(store.evictions).toBe(0)
        // "a" kept its state: its fourth attempt in the window is still counted.
        store.consume('a', SLIDING)
        store.consume('a', SLIDING)
        expect(store.consume('a', SLIDING).allowed).toBe(false)
    })

    it('evicts the oldest active key when nothing is expired', () => {
        const store = createRateLimitStore({ maxKeys: 4, now: clock().now })
        for (const key of ['a', 'b', 'c', 'd']) {
            for (let i = 0; i < 3; i++) store.consume(key, SLIDING)
        }
        store.consume('e', SLIDING)
        expect(store.size).toBe(4)
        expect(store.evictions).toBe(1)
        // Quotas are not strict on overflow: "a" was evicted and starts afresh.
        expect(store.consume('a', SLIDING).allowed).toBe(true)
    })

    it('inspects at most evictScan keys per insert', () => {
        const store = createRateLimitStore({
            maxKeys: 4,
            evictScan: 2,
            now: clock().now,
        })
        for (const key of ['a', 'b', 'c', 'd']) store.consume(key, SLIDING)
        store.consume('e', SLIDING)
        expect(store.lastInsertScan).toBe(2)
        store.consume('e', SLIDING) // existing key: no scan
        store.consume('f', SLIDING)
        expect(store.lastInsertScan).toBeLessThanOrEqual(2)
    })

    it('gc removes expired keys', () => {
        const c = clock()
        const store = createRateLimitStore({ now: c.now })
        store.consume('a', SLIDING)
        store.consume('b', FIXED)
        c.advance(1_000)
        expect(store.gc()).toBe(2)
        expect(store.size).toBe(0)
    })
})

describe('retryAfterSeconds', () => {
    it('rounds up and never returns 0', () => {
        expect(retryAfterSeconds(ms(1))).toBe(1)
        expect(retryAfterSeconds(ms(0))).toBe(1)
        expect(retryAfterSeconds(ms(1_001))).toBe(2)
    })

    // feat-270 (plan Р7): it divides by 1000, so a value already in seconds must not reach it.
    it('takes milliseconds only', () => {
        const typeCases = (): unknown[] => [
            // @ts-expect-error seconds would be divided by 1000 a second time
            retryAfterSeconds(seconds(30)),
            // @ts-expect-error a bare number names no unit
            retryAfterSeconds(30_000),
        ]
        expect(typeof typeCases).toBe('function')
    })
})
