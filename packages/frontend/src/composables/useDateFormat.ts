import { i18n } from '@/plugins/i18n'
import { useStateStore } from '@/stores/state'

/**
 * Dates in the time zone of the profile, or of the browser while the profile has none
 * (feat-232, Р8), in the language of the interface. The server, the API and the database keep
 * UTC; only the display moves. The time zone of a push subscription (stores/push.ts) is the
 * device's own and does not use this.
 */
export interface DateFormatOptions {
    /** An IANA zone or `UTC`; `null` or absent is the zone of the browser. */
    timeZone?: string | null
    locale?: string
    /** What an absent date shows. */
    empty?: string
}

type DateInput = string | number | Date | null | undefined

const toDate = (value: DateInput): Date | null => {
    if (value === null || value === undefined || value === '') return null
    const date = value instanceof Date ? value : new Date(value)
    return Number.isNaN(date.getTime()) ? null : date
}

const zoneOption = (timeZone: string | null | undefined): { timeZone?: string } =>
    timeZone === null || timeZone === undefined ? {} : { timeZone }

function format(
    value: DateInput,
    options: DateFormatOptions,
    parts: Intl.DateTimeFormatOptions,
): string {
    const date = toDate(value)
    if (date === null) return options.empty ?? '—'
    try {
        return new Intl.DateTimeFormat(options.locale, {
            ...parts,
            ...zoneOption(options.timeZone),
        }).format(date)
    } catch {
        // A zone this browser does not know: its own zone rather than no date.
        return new Intl.DateTimeFormat(options.locale, parts).format(date)
    }
}

export function formatDateTime(value: DateInput, options: DateFormatOptions = {}): string {
    return format(value, options, {
        year: 'numeric',
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
    })
}

export function formatDate(value: DateInput, options: DateFormatOptions = {}): string {
    return format(value, options, { year: 'numeric', month: 'short', day: '2-digit' })
}

const RELATIVE_STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
    ['second', 60],
    ['minute', 60],
    ['hour', 24],
    ['day', 7],
    ['week', 4.345],
    ['month', 12],
    ['year', Number.POSITIVE_INFINITY],
]

/** "3 minutes ago", "in 2 days": the time zone does not change a distance. */
export function formatRelative(
    value: DateInput,
    options: DateFormatOptions & { now?: Date } = {},
): string {
    const date = toDate(value)
    if (date === null) return options.empty ?? '—'
    let amount = (date.getTime() - (options.now ?? new Date()).getTime()) / 1000
    const formatter = new Intl.RelativeTimeFormat(options.locale, { numeric: 'auto' })
    for (const [unit, size] of RELATIVE_STEPS) {
        if (Math.abs(amount) < size) return formatter.format(Math.round(amount), unit)
        amount /= size
    }
    return formatter.format(Math.round(amount), 'year')
}

/** The formatters bound to the profile time zone and the interface language. */
export function useDateFormat() {
    const stateStore = useStateStore()
    const current = (options: DateFormatOptions): DateFormatOptions => ({
        timeZone: stateStore.timeZone,
        locale: i18n.global.locale.value,
        ...options,
    })
    return {
        formatDateTime: (value: DateInput, options: DateFormatOptions = {}) =>
            formatDateTime(value, current(options)),
        formatDate: (value: DateInput, options: DateFormatOptions = {}) =>
            formatDate(value, current(options)),
        formatRelative: (value: DateInput, options: DateFormatOptions = {}) =>
            formatRelative(value, current(options)),
    }
}
