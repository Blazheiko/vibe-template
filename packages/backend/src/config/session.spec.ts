import { describe, expect, it } from 'vitest'

import { readTokenCheckPoolMax, readTokenCheckTimeoutMs } from './session.js'

describe('readTokenCheckTimeoutMs (SESSION_TOKEN_CHECK_TIMEOUT_MS)', () => {
    it('defaults to 2000 ms when unset or empty', () => {
        expect(readTokenCheckTimeoutMs({})).toBe(2000)
        expect(readTokenCheckTimeoutMs({ SESSION_TOKEN_CHECK_TIMEOUT_MS: '' })).toBe(2000)
        expect(readTokenCheckTimeoutMs({ SESSION_TOKEN_CHECK_TIMEOUT_MS: '  ' })).toBe(2000)
    })

    it('reads a positive integer', () => {
        expect(readTokenCheckTimeoutMs({ SESSION_TOKEN_CHECK_TIMEOUT_MS: '750' })).toBe(750)
        expect(readTokenCheckTimeoutMs({ SESSION_TOKEN_CHECK_TIMEOUT_MS: '60000' })).toBe(60000)
    })

    it.each(['0', '-5', '1.5', 'abc', '1e3', '0x10', '60001'])('rejects %s', (value) => {
        expect(() => readTokenCheckTimeoutMs({ SESSION_TOKEN_CHECK_TIMEOUT_MS: value })).toThrow(
            /SESSION_TOKEN_CHECK_TIMEOUT_MS/,
        )
    })
})

describe('readTokenCheckPoolMax (SESSION_TOKEN_CHECK_POOL_MAX)', () => {
    it('defaults to 5 when unset or empty', () => {
        expect(readTokenCheckPoolMax({})).toBe(5)
        expect(readTokenCheckPoolMax({ SESSION_TOKEN_CHECK_POOL_MAX: '' })).toBe(5)
    })

    it('reads a positive integer up to 50', () => {
        expect(readTokenCheckPoolMax({ SESSION_TOKEN_CHECK_POOL_MAX: '1' })).toBe(1)
        expect(readTokenCheckPoolMax({ SESSION_TOKEN_CHECK_POOL_MAX: '50' })).toBe(50)
    })

    it.each(['0', '-1', '2.5', 'ten', '1e1', '0x5', '51'])('rejects %s', (value) => {
        expect(() => readTokenCheckPoolMax({ SESSION_TOKEN_CHECK_POOL_MAX: value })).toThrow(
            /SESSION_TOKEN_CHECK_POOL_MAX/,
        )
    })
})
