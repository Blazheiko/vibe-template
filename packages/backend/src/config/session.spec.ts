import { describe, expect, it } from 'vitest'

import { readTokenCheckTimeoutMs } from './session.js'

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
