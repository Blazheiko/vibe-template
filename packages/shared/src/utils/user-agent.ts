// feat-233 (Р6): a small User-Agent parser, enough for "Chrome on macOS" in the session list and
// in the new sign-in mail. Both read it from here, so they name a device the same way. No
// dependency: ua-parser-js v2 is AGPL. The raw string is shown next to it, so a wrong guess
// misleads nobody.

export const UA_BROWSERS = [
    'Edge',
    'Opera',
    'Samsung Internet',
    'Firefox',
    'Chrome',
    'Safari',
] as const
export const UA_OPERATING_SYSTEMS = [
    'Windows',
    'macOS',
    'iOS',
    'Android',
    'ChromeOS',
    'Linux',
] as const
export const UA_DEVICE_TYPES = ['desktop', 'mobile', 'tablet', 'unknown'] as const

export type UaBrowser = (typeof UA_BROWSERS)[number] | 'unknown'
export type UaOperatingSystem = (typeof UA_OPERATING_SYSTEMS)[number] | 'unknown'
export type UaDeviceType = (typeof UA_DEVICE_TYPES)[number]

export interface ParsedUserAgent {
    browser: UaBrowser
    os: UaOperatingSystem
    deviceType: UaDeviceType
}

/** Longer strings are cut before parsing: the backend stores at most this much (Р3). */
export const USER_AGENT_MAX_LENGTH = 512

// Order matters: Edge, Opera and Samsung Internet also say "Chrome" and "Safari"; Chrome says
// "Safari" too.
const BROWSER_RULES: readonly [UaBrowser, RegExp][] = [
    ['Edge', /\b(?:Edg|EdgA|EdgiOS|Edge)\/\d/],
    ['Opera', /\b(?:OPR|OPiOS|Opera)\/\d|\bOpera\b/],
    ['Samsung Internet', /\bSamsungBrowser\/\d/],
    ['Firefox', /\b(?:Firefox|FxiOS)\/\d/],
    ['Chrome', /\b(?:Chrome|CriOS|Chromium)\/\d/],
    ['Safari', /\bVersion\/\d[\d.]*.*\bSafari\/\d/],
]

// iOS before macOS (an iPhone says "like Mac OS X"), Android before Linux.
const OS_RULES: readonly [UaOperatingSystem, RegExp][] = [
    ['iOS', /\b(?:iPhone|iPad|iPod)\b/],
    ['Android', /\bAndroid\b/],
    ['Windows', /\bWindows (?:NT|Phone)\b|\bWin64\b/],
    ['ChromeOS', /\bCrOS\b/],
    ['macOS', /\bMacintosh\b|\bMac OS X\b/],
    ['Linux', /\bLinux\b|\bX11\b/],
]

const DESKTOP_OS: ReadonlySet<UaOperatingSystem> = new Set([
    'Windows',
    'macOS',
    'ChromeOS',
    'Linux',
])

const firstMatch = <T>(rules: readonly [T, RegExp][], ua: string, fallback: T): T => {
    for (const [name, pattern] of rules) {
        if (pattern.test(ua)) return name
    }
    return fallback
}

const deviceTypeOf = (ua: string, os: UaOperatingSystem): UaDeviceType => {
    if (/\biPad\b|\bTablet\b/.test(ua)) return 'tablet'
    if (os === 'Android') return /\bMobile\b/.test(ua) ? 'mobile' : 'tablet'
    if (os === 'iOS' || /\bMobi/.test(ua)) return 'mobile'
    return DESKTOP_OS.has(os) ? 'desktop' : 'unknown'
}

/**
 * Browser, operating system and device type of a User-Agent string; `unknown` for each part it
 * cannot tell (an empty or garbage string gives `unknown` everywhere).
 */
export function parseUserAgent(userAgent: string | null | undefined): ParsedUserAgent {
    const ua = typeof userAgent === 'string' ? userAgent.slice(0, USER_AGENT_MAX_LENGTH) : ''
    if (!/^Mozilla\/|^Opera\//.test(ua)) {
        return { browser: 'unknown', os: 'unknown', deviceType: 'unknown' }
    }
    const os = firstMatch(OS_RULES, ua, 'unknown')
    return {
        browser: firstMatch(BROWSER_RULES, ua, 'unknown'),
        os,
        deviceType: deviceTypeOf(ua, os),
    }
}

/** "Chrome on macOS", "Chrome", "macOS" or null when neither is known. */
export function describeDevice(
    parsed: Pick<ParsedUserAgent, 'browser' | 'os'>,
    on = 'on',
): string | null {
    const browser = parsed.browser === 'unknown' ? null : parsed.browser
    const os = parsed.os === 'unknown' ? null : parsed.os
    if (browser !== null && os !== null) return `${browser} ${on} ${os}`
    return browser ?? os
}
