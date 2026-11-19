/**
 * The one rule for a profile time zone (feat-232, Р3), used when the server writes it, when it
 * reads it back and by the account page selector: `UTC` or an IANA zone the runtime knows.
 *
 * `Intl.supportedValuesOf('timeZone')` lists one canonical name per zone and, in Node 24, holds
 * neither `UTC` nor `Etc/UTC`, so `UTC` is added explicitly. ICU keeps the older CLDR names in
 * that list (`Europe/Kiev`, `Asia/Calcutta`), while browsers may report the current IANA name
 * (`Europe/Kyiv`): a name that `Intl.DateTimeFormat` resolves to a listed zone is allowed too.
 * The list depends on the ICU of the runtime: a zone a newer ICU no longer knows is not allowed,
 * and the server reads such a stored value as `null`.
 */
export const UTC_TIME_ZONE = 'UTC'

let cached: readonly string[] | undefined
let cachedSet: ReadonlySet<string> | undefined

function supportedTimeZones(): string[] {
    const intl = Intl as { supportedValuesOf?: (key: 'timeZone') => string[] }
    if (typeof intl.supportedValuesOf !== 'function') return []
    return intl.supportedValuesOf('timeZone')
}

/** `UTC` first, then the zones of the runtime in its order. */
export function allowedTimeZones(): readonly string[] {
    if (cached === undefined) {
        cached = [UTC_TIME_ZONE, ...supportedTimeZones().filter((zone) => zone !== UTC_TIME_ZONE)]
        cachedSet = new Set(cached)
    }
    return cached
}

function listed(value: string): boolean {
    allowedTimeZones()
    return cachedSet?.has(value) === true
}

export function isAllowedTimeZone(value: unknown): value is string {
    if (typeof value !== 'string' || value === '' || value.length > 64) return false
    if (listed(value)) return true
    try {
        const resolved = new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions()
            .timeZone
        return listed(resolved)
    } catch {
        return false
    }
}
