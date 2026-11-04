import { describe, expect, it } from 'vitest'

import { readDatabasePoolConfig } from './database-pool.js'

describe('readDatabasePoolConfig (DB_QUERY_TIMEOUT_MS, feat-113)', () => {
    it('defaults to 10000 ms when unset or empty', () => {
        expect(readDatabasePoolConfig({})).toEqual({ queryTimeoutMs: 10_000, configError: null })
        expect(readDatabasePoolConfig({ DB_QUERY_TIMEOUT_MS: ' ' }).queryTimeoutMs).toBe(10_000)
    })

    it('reads an integer from 100 to 600000', () => {
        expect(readDatabasePoolConfig({ DB_QUERY_TIMEOUT_MS: '100' }).queryTimeoutMs).toBe(100)
        expect(readDatabasePoolConfig({ DB_QUERY_TIMEOUT_MS: '600000' }).queryTimeoutMs).toBe(
            600_000,
        )
    })

    it.each(['0', '99', '600001', '-5', '1.5', 'abc', '1e4'])('reports %s', (value) => {
        expect(readDatabasePoolConfig({ DB_QUERY_TIMEOUT_MS: value }).configError).toMatch(
            /DB_QUERY_TIMEOUT_MS must be an integer from 100 to 600000/,
        )
    })
})
