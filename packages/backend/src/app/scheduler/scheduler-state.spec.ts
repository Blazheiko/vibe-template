import { describe, expect, it } from 'vitest'

import { backoffDelay, maxBackoffOf } from './scheduler-state.js'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

describe('maxBackoffOf', () => {
    it('is the interval of a short every schedule', () => {
        expect(maxBackoffOf({ every: '15m' })).toBe(15 * MINUTE)
        expect(maxBackoffOf({ every: '1m' })).toBe(MINUTE)
    })

    it('is at most an hour', () => {
        expect(maxBackoffOf({ every: '1h' })).toBe(HOUR)
        expect(maxBackoffOf({ every: '6h' })).toBe(HOUR)
        expect(maxBackoffOf({ dailyAt: '03:00' })).toBe(HOUR)
    })
})

describe('backoffDelay', () => {
    it('doubles from one minute up to the maximum', () => {
        expect([1, 2, 3, 4, 5, 6, 7, 8].map((n) => backoffDelay(n, HOUR) / MINUTE)).toEqual([
            1, 2, 4, 8, 16, 32, 60, 60,
        ])
    })

    it('stays at the maximum for any number of failures', () => {
        expect(backoffDelay(10_000, HOUR)).toBe(HOUR)
        expect(backoffDelay(3, 2 * MINUTE)).toBe(2 * MINUTE)
    })
})
