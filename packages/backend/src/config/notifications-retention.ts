import { env } from 'node:process'

// feat-236 (Р10): the notifications-retention job (app/scheduler/jobs/notifications-retention.ts).
// A module of its own, so only the job and the startup check read it.

export const NOTIFICATIONS_RETENTION_DAYS_DEFAULT = 90
export const NOTIFICATIONS_RETENTION_DAYS_MIN = 7
export const NOTIFICATIONS_PURGE_BATCH_SIZE_DEFAULT = 1000
export const NOTIFICATIONS_PURGE_BATCH_SIZE_MAX = 10_000

export interface NotificationsRetentionConfig {
    /** NOTIFICATIONS_RETENTION_DAYS: how long a notification is kept, in days (default 90). */
    retentionDays: number
    /** NOTIFICATIONS_PURGE_BATCH_SIZE: rows one DELETE removes (default 1000). */
    batchSize: number
    configError: string | null
}

const readInteger = (
    source: NodeJS.ProcessEnv,
    name: string,
    fallback: number,
    min: number,
    max: number,
): { value: number; error: string | null } => {
    const raw = source[name]?.trim() ?? ''
    if (raw === '') return { value: fallback, error: null }
    if (!/^\d+$/.test(raw)) {
        return { value: fallback, error: `${name}: "${raw}" is not a whole number` }
    }
    const value = Number(raw)
    if (value < min || value > max) {
        return {
            value: fallback,
            error: `${name}: ${raw} is outside ${String(min)}..${String(max)}`,
        }
    }
    return { value, error: null }
}

export function readNotificationsRetentionConfig(
    source: NodeJS.ProcessEnv = env,
): NotificationsRetentionConfig {
    const days = readInteger(
        source,
        'NOTIFICATIONS_RETENTION_DAYS',
        NOTIFICATIONS_RETENTION_DAYS_DEFAULT,
        NOTIFICATIONS_RETENTION_DAYS_MIN,
        100_000,
    )
    const batch = readInteger(
        source,
        'NOTIFICATIONS_PURGE_BATCH_SIZE',
        NOTIFICATIONS_PURGE_BATCH_SIZE_DEFAULT,
        1,
        NOTIFICATIONS_PURGE_BATCH_SIZE_MAX,
    )
    return {
        retentionDays: days.value,
        batchSize: batch.value,
        configError: days.error ?? batch.error,
    }
}

export default Object.freeze(readNotificationsRetentionConfig())
