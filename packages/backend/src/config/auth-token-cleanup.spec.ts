import { describe, expect, it } from 'vitest'

import { readAuthTokenCleanupConfig } from './auth-token-cleanup.js'

// feat-223: AUTH_TOKEN_RETENTION, how long after expires_at the cleanup keeps a token.

const DAY = 24 * 60 * 60 * 1000
const read = (raw?: string) =>
    readAuthTokenCleanupConfig(raw === undefined ? {} : { AUTH_TOKEN_RETENTION: raw })

describe('readAuthTokenCleanupConfig', () => {
    it('defaults to 7 days', () => {
        expect(read()).toEqual({ retentionMs: 7 * DAY, configError: null })
        expect(read('  ')).toEqual({ retentionMs: 7 * DAY, configError: null })
    })

    it('reads a duration', () => {
        expect(read('30d')).toEqual({ retentionMs: 30 * DAY, configError: null })
        expect(read('12h')).toEqual({ retentionMs: DAY / 2, configError: null })
    })

    it.each(['7', '-1d', 'week', '0d'])('reports %j and keeps the default', (raw) => {
        const config = read(raw)
        expect(config.retentionMs).toBe(7 * DAY)
        expect(config.configError).toMatch(/^AUTH_TOKEN_RETENTION: /)
    })
})
