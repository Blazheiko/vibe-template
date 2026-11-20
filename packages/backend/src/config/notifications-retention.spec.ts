import { describe, expect, it } from 'vitest'

import { readNotificationsRetentionConfig } from './notifications-retention.js'

// feat-236 (Р10): NOTIFICATIONS_RETENTION_DAYS and NOTIFICATIONS_PURGE_BATCH_SIZE.

describe('readNotificationsRetentionConfig', () => {
    it('defaults to 90 days and batches of 1000', () => {
        expect(readNotificationsRetentionConfig({})).toEqual({
            retentionDays: 90,
            batchSize: 1000,
            configError: null,
        })
    })

    it('reads both values', () => {
        expect(
            readNotificationsRetentionConfig({
                NOTIFICATIONS_RETENTION_DAYS: '180',
                NOTIFICATIONS_PURGE_BATCH_SIZE: '50',
            }),
        ).toEqual({ retentionDays: 180, batchSize: 50, configError: null })
        expect(
            readNotificationsRetentionConfig({ NOTIFICATIONS_RETENTION_DAYS: '7' }).configError,
        ).toBeNull()
    })

    it.each(['6', '0', '-5', '1y', '90.5'])('refuses a retention of %j', (raw) => {
        const config = readNotificationsRetentionConfig({ NOTIFICATIONS_RETENTION_DAYS: raw })
        expect(config.configError).toMatch(/^NOTIFICATIONS_RETENTION_DAYS: /)
    })

    it.each(['0', '10001', 'many'])('refuses a batch size of %j', (raw) => {
        const config = readNotificationsRetentionConfig({ NOTIFICATIONS_PURGE_BATCH_SIZE: raw })
        expect(config.configError).toMatch(/^NOTIFICATIONS_PURGE_BATCH_SIZE: /)
    })
})
