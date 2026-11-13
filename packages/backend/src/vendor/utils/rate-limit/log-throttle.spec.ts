import { describe, expect, it } from 'vitest'

import { createLogThrottle } from './log-throttle.js'

describe('createLogThrottle (feat-206)', () => {
    it('lets one line through per key and window and counts the rest', () => {
        const throttle = createLogThrottle()

        expect(throttle.shouldLog('a', 1000, 0)).toBe(0)
        expect(throttle.shouldLog('a', 1000, 1)).toBeNull()
        expect(throttle.shouldLog('a', 1000, 999)).toBeNull()
        // The window is over: the next line says two were left out.
        expect(throttle.shouldLog('a', 1000, 1000)).toBe(2)
        expect(throttle.shouldLog('a', 1000, 1001)).toBeNull()
    })

    it('keeps keys apart', () => {
        const throttle = createLogThrottle()

        expect(throttle.shouldLog('a', 1000, 0)).toBe(0)
        expect(throttle.shouldLog('b', 1000, 0)).toBe(0)
    })

    it('stays bounded: a full table of fresh keys logs no new key, expired ones give room', () => {
        const throttle = createLogThrottle(2)

        expect(throttle.shouldLog('a', 1000, 0)).toBe(0)
        expect(throttle.shouldLog('b', 1000, 0)).toBe(0)
        expect(throttle.shouldLog('c', 1000, 1)).toBeNull()
        expect(throttle.size()).toBe(2)

        expect(throttle.shouldLog('c', 1000, 1000)).toBe(0)
        expect(throttle.size()).toBe(1)
    })
})
