import { NOT_OWNER, type HeldLease } from '#app/services/shared/redis-lease.js'
import redis, { withRedis } from '#database/redis.js'

import { periodOf, type Schedule } from './schedule.js'

// feat-222 (scheduler plan Р3, Р11): the state of a job in the hash `sched:state:<job>`.
// Every write is one Lua script run through lease.evalAsOwner: it happens only while the writer
// still owns `sched:lease:<job>`, so a former owner cannot overwrite what the new one wrote.

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS

export const stateKey = (job: string): string => `sched:state:${job}`

export interface JobState {
    lastSuccessSlot?: number
    consecutiveFailures: number
    nextRetryAt?: number
    lastRunAt?: number
    lastOutcome?: string
    lastDurationMs?: number
}

export type SuccessWrite = { status: 'written' } | { status: 'not-owner' }
export type FailureWrite = { status: 'written'; nextRetryAt: number } | { status: 'not-owner' }

export interface SuccessRecord {
    slot: number
    durationMs: number
    now: number
}

export interface FailureRecord {
    outcome: 'failed' | 'timeout'
    durationMs: number
    now: number
    maxBackoffMs: number
}

export interface SchedulerState {
    read(job: string): Promise<JobState>
    recordSuccess(lease: HeldLease, job: string, record: SuccessRecord): Promise<SuccessWrite>
    recordFailure(lease: HeldLease, job: string, record: FailureRecord): Promise<FailureWrite>
}

/** Р3: 1m, 2m, 4m … after the 1st, 2nd, 3rd failure in a row, at most `maxBackoffMs`. */
export const backoffDelay = (failures: number, maxBackoffMs: number): number =>
    Math.min(MINUTE_MS * 2 ** Math.max(0, failures - 1), maxBackoffMs)

/** Р3: min(every, 1h) for `every`, 1h for `dailyAt`. */
export const maxBackoffOf = (schedule: Schedule): number =>
    'every' in schedule ? Math.min(periodOf(schedule), HOUR_MS) : HOUR_MS

// KEYS[1] lease, ARGV[1] token (checked by evalAsOwner); KEYS[2] state.
// ARGV[2] slot, ARGV[3] now, ARGV[4] durationMs.
const SUCCESS_LUA = `
local old = tonumber(redis.call('HGET', KEYS[2], 'lastSuccessSlot'))
if old == nil or tonumber(ARGV[2]) > old then
  redis.call('HSET', KEYS[2], 'lastSuccessSlot', ARGV[2])
end
redis.call('HSET', KEYS[2], 'consecutiveFailures', '0', 'lastRunAt', ARGV[3],
  'lastOutcome', 'ok', 'lastDurationMs', ARGV[4])
redis.call('HDEL', KEYS[2], 'nextRetryAt')
return 'written'
`

// ARGV[2] now, ARGV[3] durationMs, ARGV[4] outcome, ARGV[5] maxBackoffMs. Same formula as
// backoffDelay. The time is returned as a string: a Lua number would come back truncated to an
// integer reply anyway, a string keeps the reply shape explicit.
const FAILURE_LUA = `
local failures = redis.call('HINCRBY', KEYS[2], 'consecutiveFailures', 1)
local delay = math.min(${String(MINUTE_MS)} * 2 ^ (failures - 1), tonumber(ARGV[5]))
local nextRetryAt = string.format('%.0f', tonumber(ARGV[2]) + delay)
redis.call('HSET', KEYS[2], 'nextRetryAt', nextRetryAt, 'lastRunAt', ARGV[2],
  'lastOutcome', ARGV[4], 'lastDurationMs', ARGV[3])
return nextRetryAt
`

const toNumber = (value: string | undefined): number | undefined => {
    if (value === undefined || value === '') return undefined
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
}

export const redisSchedulerState: SchedulerState = {
    async read(job) {
        const hash = await withRedis(() => redis.hgetall(stateKey(job)))
        const state: JobState = {
            consecutiveFailures: toNumber(hash['consecutiveFailures']) ?? 0,
        }
        const lastSuccessSlot = toNumber(hash['lastSuccessSlot'])
        if (lastSuccessSlot !== undefined) state.lastSuccessSlot = lastSuccessSlot
        const nextRetryAt = toNumber(hash['nextRetryAt'])
        if (nextRetryAt !== undefined) state.nextRetryAt = nextRetryAt
        const lastRunAt = toNumber(hash['lastRunAt'])
        if (lastRunAt !== undefined) state.lastRunAt = lastRunAt
        const lastDurationMs = toNumber(hash['lastDurationMs'])
        if (lastDurationMs !== undefined) state.lastDurationMs = lastDurationMs
        if (hash['lastOutcome'] !== undefined) state.lastOutcome = hash['lastOutcome']
        return state
    },

    async recordSuccess(lease, job, { slot, durationMs, now }) {
        const reply = await lease.evalAsOwner(
            SUCCESS_LUA,
            [stateKey(job)],
            [slot, now, Math.round(durationMs)],
        )
        return reply === NOT_OWNER ? { status: 'not-owner' } : { status: 'written' }
    },

    async recordFailure(lease, job, { outcome, durationMs, now, maxBackoffMs }) {
        const reply = await lease.evalAsOwner(
            FAILURE_LUA,
            [stateKey(job)],
            [now, Math.round(durationMs), outcome, maxBackoffMs],
        )
        if (reply === NOT_OWNER) return { status: 'not-owner' }
        return { status: 'written', nextRetryAt: Number(reply) }
    },
}
