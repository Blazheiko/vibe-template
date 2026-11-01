// Where a push notification takes the user. The address comes from the push payload, so the
// service worker (which opens it and looks for a window already showing it) treats it as input:
// it may only point inside the application, and "the same page" is decided by the parsed path.
// Free of service worker globals so it can be unit-tested.

/**
 * The address to open for a notification: the payload's `url` resolved against the
 * application's origin, or the start page when it is missing, unparsable or leaves the origin
 * (another host, port or scheme, `//host`, `/\host`, `javascript:` and the like).
 */
export const resolveNotificationTarget = (raw: unknown, origin: string): string => {
    const start = new URL('/', origin).href
    if (typeof raw !== 'string' || raw.trim() === '') return start
    try {
        const url = new URL(raw.trim(), origin)
        return url.origin === new URL(origin).origin ? url.href : start
    } catch {
        return start
    }
}

/**
 * Whether a window already shows the target page: same origin and same path. The query and
 * the fragment are ignored; a substring match (`includes`) took `/support/archive`, and any
 * address that merely contained the target, for the page.
 */
export const isSameTarget = (clientUrl: string, target: string): boolean => {
    try {
        const client = new URL(clientUrl)
        const wanted = new URL(target)
        return client.origin === wanted.origin && client.pathname === wanted.pathname
    } catch {
        return false
    }
}
