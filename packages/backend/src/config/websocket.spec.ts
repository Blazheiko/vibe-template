import { describe, expect, it } from 'vitest'

import { readWsAdminRecheckIntervalMs } from './websocket.js'

describe('readWsAdminRecheckIntervalMs (WS_ADMIN_RECHECK_INTERVAL_MS)', () => {
    it('defaults to 30000 ms when unset or empty', () => {
        expect(readWsAdminRecheckIntervalMs({})).toBe(30_000)
        expect(readWsAdminRecheckIntervalMs({ WS_ADMIN_RECHECK_INTERVAL_MS: '' })).toBe(30_000)
        expect(readWsAdminRecheckIntervalMs({ WS_ADMIN_RECHECK_INTERVAL_MS: '  ' })).toBe(30_000)
    })

    it('reads an integer from 100 to 3600000', () => {
        expect(readWsAdminRecheckIntervalMs({ WS_ADMIN_RECHECK_INTERVAL_MS: '100' })).toBe(100)
        expect(readWsAdminRecheckIntervalMs({ WS_ADMIN_RECHECK_INTERVAL_MS: '1000' })).toBe(1000)
        expect(readWsAdminRecheckIntervalMs({ WS_ADMIN_RECHECK_INTERVAL_MS: '3600000' })).toBe(
            3_600_000,
        )
    })

    it.each(['0', '99', '-1', '1.5', 'abc', '1e3', '0x10', '3600001'])('rejects %s', (value) => {
        expect(() => readWsAdminRecheckIntervalMs({ WS_ADMIN_RECHECK_INTERVAL_MS: value })).toThrow(
            /WS_ADMIN_RECHECK_INTERVAL_MS/,
        )
    })
})
