// feat-278 (T5): recovery from a chunk that fails to load. Every page except Login is a lazy
// chunk; after a deploy an open tab still asks for the chunks of its own build, which the new
// server no longer has (the image carries the dist of one build). One reload brings the new
// build; a guard in sessionStorage keeps it from turning into a reload loop.
//
// The order of events matters. A failed import of a route component fires `vite:preloadError`
// synchronously, before the rejection reaches `router.onError`, and before the address bar
// shows the target. So a navigation is recovered in `router.onError`, which knows `to`; the
// window listener handles only imports outside a navigation (an async component opened later).
// The listener calls `preventDefault()` only when it reloads itself: a prevented event makes
// Vite resolve the import with `undefined` instead of rejecting it.
import { shallowRef } from 'vue'
import type { RouteLocationNormalized, Router } from 'vue-router'

/** What the app shows while a chunk cannot be loaded; `null` when nothing. */
export type ChunkLoadNotice = { kind: 'offline' | 'failed'; target: string } | null

/** Rendered by ChunkLoadNotice.vue. */
export const chunkLoadNotice = shallowRef<ChunkLoadNotice>(null)

// Chromium, Firefox, Safari, and Vite's own CSS preload error.
const CHUNK_ERROR =
    /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS|Failed to load module script/i

export function isChunkLoadError(error: unknown): boolean {
    return error instanceof Error && CHUNK_ERROR.test(error.message)
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export interface RecoveryEnv {
    onLine: boolean
    /** `null` when sessionStorage is unavailable (blocked, private mode): no loop guard. */
    storage: StorageLike | null
    buildTimestamp: string
}

/**
 * `reload`: the first failure for this page and build, reload once.
 * `wait-online`: offline, reload when the network is back.
 * `gave-up`: a reload already happened and did not help.
 * `manual`: no storage for the loop guard, so the user reloads by hand.
 */
export type RecoveryOutcome = 'reload' | 'wait-online' | 'gave-up' | 'manual'

/** By the path only: the query may carry a one-time `?token=`. */
export function attemptKey(path: string, buildTimestamp: string): string {
    return `chunk-reload:${buildTimestamp}:${path}`
}

export function decideRecovery(path: string, env: RecoveryEnv): RecoveryOutcome {
    if (!env.onLine) return 'wait-online'
    if (env.storage === null) return 'manual'
    const key = attemptKey(path, env.buildTimestamp)
    try {
        if (env.storage.getItem(key) !== null) return 'gave-up'
        env.storage.setItem(key, '1')
        return 'reload'
    } catch {
        return 'manual'
    }
}

export interface RecoveryDeps {
    env: () => RecoveryEnv
    /** A full page load of `url`. */
    navigate: (url: string) => void
    onceOnline: (callback: () => void) => void
    /** Only a failure the recovery gave up on is reported. */
    report: (error: unknown, path: string) => void
    addWindowListener: (listener: (event: Event & { payload?: unknown }) => void) => void
    currentUrl: () => { href: string; path: string }
}

function browserStorage(): StorageLike | null {
    try {
        return window.sessionStorage
    } catch {
        return null
    }
}

export function browserRecoveryDeps(
    buildTimestamp: string,
    report: RecoveryDeps['report'],
): RecoveryDeps {
    return {
        env: () => ({ onLine: navigator.onLine, storage: browserStorage(), buildTimestamp }),
        navigate: (url) => {
            window.location.assign(url)
        },
        onceOnline: (callback) => {
            window.addEventListener('online', callback, { once: true })
        },
        report,
        addWindowListener: (listener) => {
            window.addEventListener('vite:preloadError', listener)
        },
        currentUrl: () => ({
            href: window.location.href,
            path: window.location.pathname,
        }),
    }
}

/**
 * Wires the recovery into the router and the window. Returns `recover` for a test.
 */
export function installPreloadRecovery(
    router: Router,
    deps: RecoveryDeps,
): (target: string, path: string, error: unknown) => RecoveryOutcome {
    let pending: RouteLocationNormalized | null = null

    const recover = (
        target: string,
        path: string,
        error: unknown,
        beforeReload: () => void = () => undefined,
    ): RecoveryOutcome => {
        const outcome = decideRecovery(path, deps.env())
        if (outcome === 'reload') {
            beforeReload()
            deps.navigate(target)
        } else if (outcome === 'wait-online') {
            chunkLoadNotice.value = { kind: 'offline', target }
            deps.onceOnline(() => {
                deps.navigate(target)
            })
        } else {
            chunkLoadNotice.value = { kind: 'failed', target }
            if (outcome === 'gave-up') deps.report(error, path)
        }
        return outcome
    }

    router.beforeEach((to) => {
        pending = to
    })
    router.afterEach((to, _from, failure) => {
        pending = null
        if (failure !== undefined) return
        chunkLoadNotice.value = null
        try {
            deps.env().storage?.removeItem(attemptKey(to.path, deps.env().buildTimestamp))
        } catch {
            // Nothing to clean when the storage is unavailable.
        }
    })
    router.onError((error, to) => {
        pending = null
        if (isChunkLoadError(error)) recover(to.fullPath, to.path, error)
    })

    deps.addWindowListener((event) => {
        // A navigation is in flight: the rejection goes on to router.onError, which knows `to`.
        if (pending !== null) return
        const { href, path } = deps.currentUrl()
        recover(href, path, event.payload, () => {
            event.preventDefault()
        })
    })

    return recover
}
