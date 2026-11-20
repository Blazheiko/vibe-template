import { describe, expect, it } from 'vitest'

import { readAuditEventsRetentionConfig } from './audit-events-retention.js'

// feat-235 (Р9): AUDIT_EVENTS_RETENTION_DAYS and AUDIT_EVENTS_PURGE_BATCH_SIZE.

describe('readAuditEventsRetentionConfig', () => {
    it('defaults to 365 days and batches of 1000', () => {
        expect(readAuditEventsRetentionConfig({})).toEqual({
            retentionDays: 365,
            batchSize: 1000,
            configError: null,
        })
    })

    it('reads both values', () => {
        expect(
            readAuditEventsRetentionConfig({
                AUDIT_EVENTS_RETENTION_DAYS: '90',
                AUDIT_EVENTS_PURGE_BATCH_SIZE: '50',
            }),
        ).toEqual({ retentionDays: 90, batchSize: 50, configError: null })
        expect(
            readAuditEventsRetentionConfig({ AUDIT_EVENTS_RETENTION_DAYS: '30' }).configError,
        ).toBeNull()
    })

    it.each(['29', '0', '-5', '1y', '365.5'])('refuses a retention of %j', (raw) => {
        const config = readAuditEventsRetentionConfig({ AUDIT_EVENTS_RETENTION_DAYS: raw })
        expect(config.configError).toMatch(/^AUDIT_EVENTS_RETENTION_DAYS: /)
    })

    it.each(['0', '10001', 'many'])('refuses a batch size of %j', (raw) => {
        const config = readAuditEventsRetentionConfig({ AUDIT_EVENTS_PURGE_BATCH_SIZE: raw })
        expect(config.configError).toMatch(/^AUDIT_EVENTS_PURGE_BATCH_SIZE: /)
    })
})
