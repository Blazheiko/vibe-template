import { describe, expect, it } from 'vitest'

import { parseScheduleDuration, periodOf, slotOf, validateSchedule } from './schedule.js'

const at = (iso: string): number => Date.parse(iso)

describe('parseScheduleDuration', () => {
    it('reads whole values with a unit', () => {
        expect(parseScheduleDuration('15m')).toBe(15 * 60_000)
        expect(parseScheduleDuration('1h 30m')).toBe(90 * 60_000)
        expect(parseScheduleDuration('2d')).toBe(2 * 86_400_000)
        expect(parseScheduleDuration('30s')).toBe(30_000)
    })

    it.each(['15', '-5m', '1.5h', '0m', '', '15 m', 'garbage', '1h30m'])(
        'refuses %j and names the value',
        (raw) => {
            expect(() => parseScheduleDuration(raw)).toThrow(`"${raw}"`)
        },
    )
})

describe('slotOf: every', () => {
    const every15 = { every: '15m' }

    it('starts a slot on the UTC grid from the epoch', () => {
        expect(slotOf(every15, at('2026-11-18T03:14:59.999Z'))).toBe(at('2026-11-18T03:00:00Z'))
        expect(slotOf(every15, at('2026-11-18T03:15:00.000Z'))).toBe(at('2026-11-18T03:15:00Z'))
    })

    it('gives the same slot for every moment inside it', () => {
        const slots = ['03:15:00', '03:20:13', '03:29:59.999'].map((time) =>
            slotOf(every15, at(`2026-11-18T${time}Z`)),
        )
        expect(new Set(slots).size).toBe(1)
    })

    it('accepts an hour and a day', () => {
        expect(slotOf({ every: '1h' }, at('2026-11-18T03:59:00Z'))).toBe(at('2026-11-18T03:00:00Z'))
        expect(slotOf({ every: '1d' }, at('2026-11-18T23:59:00Z'))).toBe(at('2026-11-18T00:00:00Z'))
    })
})

describe('slotOf: dailyAt', () => {
    const daily3 = { dailyAt: '03:00' }

    it('is yesterday before the time, today from the time on', () => {
        expect(slotOf(daily3, at('2026-11-18T02:59:59Z'))).toBe(at('2026-11-17T03:00:00Z'))
        expect(slotOf(daily3, at('2026-11-18T03:00:00Z'))).toBe(at('2026-11-18T03:00:00Z'))
        expect(slotOf(daily3, at('2026-11-18T23:59:00Z'))).toBe(at('2026-11-18T03:00:00Z'))
    })

    it('crosses a month and a year', () => {
        expect(slotOf(daily3, at('2026-12-01T01:00:00Z'))).toBe(at('2026-11-30T03:00:00Z'))
        expect(slotOf(daily3, at('2027-01-01T01:00:00Z'))).toBe(at('2026-12-31T03:00:00Z'))
        expect(slotOf(daily3, at('2027-01-01T03:00:00Z'))).toBe(at('2027-01-01T03:00:00Z'))
    })

    it('handles midnight and the last minute of the day', () => {
        expect(slotOf({ dailyAt: '00:00' }, at('2026-11-18T00:00:00Z'))).toBe(
            at('2026-11-18T00:00:00Z'),
        )
        expect(slotOf({ dailyAt: '23:59' }, at('2026-11-18T23:58:00Z'))).toBe(
            at('2026-11-17T23:59:00Z'),
        )
    })
})

describe('validateSchedule', () => {
    it.each([
        [{ every: '15' }, '"15"'],
        [{ every: '-5m' }, '"-5m"'],
        [{ every: '1.5h' }, '"1.5h"'],
        [{ every: '0m' }, '"0m"'],
        [{ every: '30s' }, '"30s"'],
        [{ every: '90s' }, '"90s"'],
        [{ every: '7m' }, '"7m"'],
        [{ every: '2d' }, '"2d"'],
        [{ dailyAt: '24:00' }, '"24:00"'],
        [{ dailyAt: '3:00' }, '"3:00"'],
        [{ dailyAt: '03:60' }, '"03:60"'],
    ])('refuses %j', (schedule, named) => {
        expect(() => {
            validateSchedule(schedule)
        }).toThrow(named)
    })

    it.each([{ every: '1m' }, { every: '15m' }, { every: '1h' }, { dailyAt: '03:30' }])(
        'accepts %j',
        (schedule) => {
            expect(() => {
                validateSchedule(schedule)
            }).not.toThrow()
        },
    )

    it('gives the period of a schedule', () => {
        expect(periodOf({ every: '15m' })).toBe(15 * 60_000)
        expect(periodOf({ dailyAt: '03:00' })).toBe(86_400_000)
    })
})
