import { safeRedirectTarget } from './safe-redirect'

// Where to go after a sign-in that leaves the application.
//
// The router guard writes the page an anonymous visitor was going to into `?redirect=`. A form
// sign-in reads it from the route. An OAuth sign-in goes to the provider and comes back to "/",
// so the target is kept in sessionStorage for the trip: the same tab, gone with it. It is a path
// inside the application when stored and is checked again when taken — the storage is not
// trusted — and it is only good for ten minutes, so a sign-in that was never finished does not
// redirect a later visit.

const KEY = 'post-sign-in-target'
const MAX_AGE_MS = 10 * 60_000

const forget = (): void => {
    try {
        sessionStorage.removeItem(KEY)
    } catch {
        // No storage (a private window, blocked site data): nothing to forget.
    }
}

/** Remembers `value` when it is a path inside the application; otherwise forgets what was kept. */
export const rememberPostSignInTarget = (value: unknown): void => {
    const target = safeRedirectTarget(value)
    if (target === null) {
        forget()
        return
    }
    try {
        sessionStorage.setItem(KEY, JSON.stringify({ target, at: Date.now() }))
    } catch {
        // No storage: the sign-in ends on the account page, as it did before.
    }
}

/** The remembered path, once: taking it forgets it. */
export const takePostSignInTarget = (): string | null => {
    let stored: string | null = null
    try {
        stored = sessionStorage.getItem(KEY)
    } catch {
        return null
    }
    if (stored === null) return null
    forget()
    try {
        const { target, at } = JSON.parse(stored) as { target?: unknown; at?: unknown }
        if (typeof at !== 'number' || Date.now() - at > MAX_AGE_MS) return null
        return safeRedirectTarget(target)
    } catch {
        return null
    }
}

export const forgetPostSignInTarget = forget
