import { describe, expect, it } from 'vitest'

import { formatDate, formatDateTime, formatRelative } from '../useDateFormat'

// feat-232 T8 (Р8): one instant, shown in the zone of the profile or of the browser.

const en = { locale: 'en-GB' }

describe('formatDateTime', () => {
    it('shows the same instant in two zones', () => {
        const instant = '2026-06-15T12:00:00.000Z'

        expect(formatDateTime(instant, { ...en, timeZone: 'Europe/Kyiv' })).toBe(
            '15 Jun 2026, 15:00',
        )
        expect(formatDateTime(instant, { ...en, timeZone: 'America/New_York' })).toBe(
            '15 Jun 2026, 08:00',
        )
        expect(formatDateTime(instant, { ...en, timeZone: 'UTC' })).toBe('15 Jun 2026, 12:00')
    })

    it('a time past midnight in one zone is the day before in another', () => {
        const instant = '2026-03-01T02:30:00.000Z'

        expect(formatDate(instant, { ...en, timeZone: 'Europe/Kyiv' })).toBe('01 Mar 2026')
        expect(formatDate(instant, { ...en, timeZone: 'America/New_York' })).toBe('28 Feb 2026')
    })

    it('follows the switch to summer time and back', () => {
        // Kyiv: +02:00 until 2026-03-29 01:00 UTC, +03:00 until 2026-10-25 01:00 UTC.
        const zone = { ...en, timeZone: 'Europe/Kyiv' }
        expect(formatDateTime('2026-03-29T00:30:00.000Z', zone)).toBe('29 Mar 2026, 02:30')
        expect(formatDateTime('2026-03-29T01:30:00.000Z', zone)).toBe('29 Mar 2026, 04:30')
        expect(formatDateTime('2026-10-25T00:30:00.000Z', zone)).toBe('25 Oct 2026, 03:30')
        expect(formatDateTime('2026-10-25T01:30:00.000Z', zone)).toBe('25 Oct 2026, 03:30')
        // New York: 2026-03-08 and 2026-11-01.
        const ny = { ...en, timeZone: 'America/New_York' }
        expect(formatDateTime('2026-03-08T06:30:00.000Z', ny)).toBe('08 Mar 2026, 01:30')
        expect(formatDateTime('2026-03-08T07:30:00.000Z', ny)).toBe('08 Mar 2026, 03:30')
    })

    it('null is the zone of the browser', () => {
        const instant = '2026-06-15T12:00:00.000Z'
        const browser = new Intl.DateTimeFormat('en-GB', {
            year: 'numeric',
            month: 'short',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
        }).format(new Date(instant))

        expect(formatDateTime(instant, { ...en, timeZone: null })).toBe(browser)
        expect(formatDateTime(instant, en)).toBe(browser)
    })

    it('an absent or broken date shows a dash; an unknown zone falls back to the browser', () => {
        expect(formatDateTime(null)).toBe('—')
        expect(formatDateTime('not a date')).toBe('—')
        expect(formatDateTime('2026-06-15T12:00:00.000Z', { ...en, timeZone: 'Mars/Base' })).toBe(
            formatDateTime('2026-06-15T12:00:00.000Z', en),
        )
    })

    it('speaks the language of the interface', () => {
        expect(formatDate('2026-06-15T12:00:00.000Z', { locale: 'uk', timeZone: 'UTC' })).toBe(
            '15 черв. 2026 р.',
        )
    })
})

describe('formatRelative', () => {
    const now = new Date('2026-06-15T12:00:00.000Z')

    it('says how far a date is, whatever the zone', () => {
        expect(formatRelative('2026-06-15T11:57:00.000Z', { locale: 'en', now })).toBe(
            '3 minutes ago',
        )
        expect(formatRelative('2026-06-17T12:00:00.000Z', { locale: 'en', now })).toBe('in 2 days')
        expect(formatRelative('2026-06-14T12:00:00.000Z', { locale: 'en', now })).toBe('yesterday')
    })
})
