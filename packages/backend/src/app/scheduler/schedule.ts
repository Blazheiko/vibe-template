import { duration } from 'metautil'

// feat-222 (scheduler plan Р2): typed schedules, no string DSL. Slots are computed here rather
// than with metautil's parseEvery/nextEvent, which give wrong slots without wrappers (see the
// plan). A slot is the start of the current period in epoch milliseconds: the same number on
// every replica, so it identifies the run across them.

const DAY_MS = 86_400_000
const MINUTE_MS = 60_000

/** Whole numbers with a unit, one or more parts: `15m`, `1h 30m`, `2d`. */
const DURATION_RE = /^\d+[dhms]( \d+[dhms])*$/
const DAILY_AT_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

/**
 * metautil's duration() with the checks it lacks: `'15'` gives 0 (no unit), `'-5m'` a negative
 * value and `'1.5h'` silently drops the fraction. Only whole values with a unit and a positive
 * result are accepted.
 */
export function parseScheduleDuration(raw: string): number {
    if (!DURATION_RE.test(raw)) {
        throw new Error(
            `"${raw}" is not a duration: use whole numbers with a unit (d, h, m, s), e.g. 15m or 1h 30m`,
        )
    }
    const ms = duration(raw)
    if (!Number.isFinite(ms) || ms <= 0) {
        throw new Error(`"${raw}" is not a positive duration`)
    }
    return ms
}

/** `every`: a UTC grid from the epoch (15m runs at :00/:15/:30/:45). `dailyAt`: `HH:MM` UTC. */
export type Schedule = { every: string } | { dailyAt: string }

const everyMs = (every: string): number => {
    const ms = parseScheduleDuration(every)
    if (ms < MINUTE_MS || ms % MINUTE_MS !== 0) {
        throw new Error(`every: "${every}" must be a whole number of minutes, at least 1m`)
    }
    // Otherwise the grid drifts against the day.
    if (DAY_MS % ms !== 0) {
        throw new Error(`every: "${every}" must divide one day without a remainder`)
    }
    return ms
}

const dailyAtMs = (dailyAt: string): number => {
    const match = DAILY_AT_RE.exec(dailyAt)
    if (match === null) {
        throw new Error(`dailyAt: "${dailyAt}" must be HH:MM (UTC), from 00:00 to 23:59`)
    }
    return (Number(match[1]) * 60 + Number(match[2])) * MINUTE_MS
}

/** Throws with the offending value when the schedule is not valid. */
export function validateSchedule(schedule: Schedule): void {
    if ('every' in schedule) everyMs(schedule.every)
    else dailyAtMs(schedule.dailyAt)
}

/** The interval of an `every` schedule, or a day for `dailyAt`. */
export function periodOf(schedule: Schedule): number {
    return 'every' in schedule ? everyMs(schedule.every) : DAY_MS
}

/**
 * The start of the current slot, in epoch ms: `floor(now / interval) * interval` for `every`;
 * for `dailyAt` today's HH:MM UTC once it has come, yesterday's before that.
 */
export function slotOf(schedule: Schedule, nowMs: number): number {
    if ('every' in schedule) {
        const interval = everyMs(schedule.every)
        return Math.floor(nowMs / interval) * interval
    }
    const today = Math.floor(nowMs / DAY_MS) * DAY_MS + dailyAtMs(schedule.dailyAt)
    return nowMs >= today ? today : today - DAY_MS
}
