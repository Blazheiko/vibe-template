import { describe, expect, it } from 'vitest'

import {
    readWsAdminRecheckIntervalMs,
    readWsMaxConcurrentHandlers,
    readWsMessagesPerMinute,
    readWsSessionRecheckIntervalMs,
} from './websocket.js'

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

// feat-195: the session re-check of every connection.
describe('readWsSessionRecheckIntervalMs (WS_SESSION_RECHECK_INTERVAL_MS)', () => {
    it('defaults to 30000 ms when unset or empty', () => {
        expect(readWsSessionRecheckIntervalMs({})).toBe(30_000)
        expect(readWsSessionRecheckIntervalMs({ WS_SESSION_RECHECK_INTERVAL_MS: '' })).toBe(30_000)
    })

    it('reads an integer from 100 to 3600000', () => {
        expect(readWsSessionRecheckIntervalMs({ WS_SESSION_RECHECK_INTERVAL_MS: '100' })).toBe(100)
        expect(readWsSessionRecheckIntervalMs({ WS_SESSION_RECHECK_INTERVAL_MS: '3600000' })).toBe(
            3_600_000,
        )
    })

    it.each(['0', '99', '-1', '1.5', 'abc', '3600001'])('rejects %s', (value) => {
        expect(() =>
            readWsSessionRecheckIntervalMs({ WS_SESSION_RECHECK_INTERVAL_MS: value }),
        ).toThrow(/WS_SESSION_RECHECK_INTERVAL_MS/)
    })
})

// feat-149: the budget of one connection.
describe('readWsMessagesPerMinute (WS_MESSAGES_PER_MINUTE)', () => {
    it('defaults to 120 when unset or empty', () => {
        expect(readWsMessagesPerMinute({})).toBe(120)
        expect(readWsMessagesPerMinute({ WS_MESSAGES_PER_MINUTE: '' })).toBe(120)
    })

    it('reads an integer from 1 to 100000', () => {
        expect(readWsMessagesPerMinute({ WS_MESSAGES_PER_MINUTE: '1' })).toBe(1)
        expect(readWsMessagesPerMinute({ WS_MESSAGES_PER_MINUTE: '100000' })).toBe(100_000)
    })

    it.each(['0', '-1', '1.5', 'abc', '1e3', '100001'])('rejects %s', (value) => {
        expect(() => readWsMessagesPerMinute({ WS_MESSAGES_PER_MINUTE: value })).toThrow(
            /WS_MESSAGES_PER_MINUTE/,
        )
    })
})

describe('readWsMaxConcurrentHandlers (WS_MAX_CONCURRENT_HANDLERS)', () => {
    it('defaults to 8 when unset or empty', () => {
        expect(readWsMaxConcurrentHandlers({})).toBe(8)
        expect(readWsMaxConcurrentHandlers({ WS_MAX_CONCURRENT_HANDLERS: '' })).toBe(8)
    })

    it('reads an integer from 1 to 1000', () => {
        expect(readWsMaxConcurrentHandlers({ WS_MAX_CONCURRENT_HANDLERS: '1' })).toBe(1)
        expect(readWsMaxConcurrentHandlers({ WS_MAX_CONCURRENT_HANDLERS: '1000' })).toBe(1000)
    })

    it.each(['0', '-1', '1.5', 'abc', '1001'])('rejects %s', (value) => {
        expect(() => readWsMaxConcurrentHandlers({ WS_MAX_CONCURRENT_HANDLERS: value })).toThrow(
            /WS_MAX_CONCURRENT_HANDLERS/,
        )
    })
})
