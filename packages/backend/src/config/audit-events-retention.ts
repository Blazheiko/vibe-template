import { env } from 'node:process'

// feat-235 (Р9): the audit-events-retention job (app/scheduler/jobs/audit-events-retention.ts).
// A module of its own, so only the job and the startup check read it.

export const AUDIT_EVENTS_RETENTION_DAYS_DEFAULT = 365
export const AUDIT_EVENTS_RETENTION_DAYS_MIN = 30
export const AUDIT_EVENTS_PURGE_BATCH_SIZE_DEFAULT = 1000
export const AUDIT_EVENTS_PURGE_BATCH_SIZE_MAX = 10_000

export interface AuditEventsRetentionConfig {
    /** AUDIT_EVENTS_RETENTION_DAYS: how long an audit event is kept, in days (default 365). */
    retentionDays: number
    /** AUDIT_EVENTS_PURGE_BATCH_SIZE: rows one DELETE removes (default 1000). */
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

export function readAuditEventsRetentionConfig(
    source: NodeJS.ProcessEnv = env,
): AuditEventsRetentionConfig {
    const days = readInteger(
        source,
        'AUDIT_EVENTS_RETENTION_DAYS',
        AUDIT_EVENTS_RETENTION_DAYS_DEFAULT,
        AUDIT_EVENTS_RETENTION_DAYS_MIN,
        100_000,
    )
    const batch = readInteger(
        source,
        'AUDIT_EVENTS_PURGE_BATCH_SIZE',
        AUDIT_EVENTS_PURGE_BATCH_SIZE_DEFAULT,
        1,
        AUDIT_EVENTS_PURGE_BATCH_SIZE_MAX,
    )
    return {
        retentionDays: days.value,
        batchSize: batch.value,
        configError: days.error ?? batch.error,
    }
}

export default Object.freeze(readAuditEventsRetentionConfig())
