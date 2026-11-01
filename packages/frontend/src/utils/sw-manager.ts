// What the page does about its service worker: register it, look for updates, tell the user when a
// newer build is waiting, and pass the worker's own errors on to Sentry. main.ts starts it with
// `startServiceWorker`; the rest is exported so that it can be tested.

export interface ServiceWorkerErrorPayload {
    type: 'SW_ERROR'
    err:
        | {
              message?: string
              stack?: string
              name?: string
          }
        | Error
}

export interface ServiceWorkerErrorContext {
    error: Error
    extra: {
        swStack?: string
        swName?: string
    }
}

export function isServiceWorkerErrorPayload(value: unknown): value is ServiceWorkerErrorPayload {
    if (!value || typeof value !== 'object') {
        return false
    }

    const data = value as Record<string, unknown>
    if (data.type !== 'SW_ERROR' || !data.err || typeof data.err !== 'object') {
        return false
    }

    return true
}

export function createServiceWorkerError(
    err: ServiceWorkerErrorPayload['err'],
): ServiceWorkerErrorContext {
    if (err instanceof Error) {
        return {
            error: err,
            extra: {},
        }
    }

    const error = new Error(typeof err.message === 'string' ? err.message : 'Service worker error')
    if (typeof err.name === 'string') {
        error.name = err.name
    }
    if (typeof err.stack === 'string') {
        error.stack = err.stack
    }
    return {
        error,
        extra: {
            swStack: typeof err.stack === 'string' ? err.stack : undefined,
            swName: typeof err.name === 'string' ? err.name : undefined,
        },
    }
}

export interface ServiceWorkerVersionMessage {
    type: 'BUILD_INFO' | 'NEW_VERSION'
    buildTimestamp: string
}

export function parseBuildTimestamp(value: unknown): number | null {
    if (typeof value !== 'string' && typeof value !== 'number') {
        return null
    }

    const timestamp = Number(value)
    return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null
}

export function isServiceWorkerVersionMessage(
    value: unknown,
): value is ServiceWorkerVersionMessage {
    if (!value || typeof value !== 'object') {
        return false
    }

    const data = value as Record<string, unknown>
    return (
        (data.type === 'BUILD_INFO' || data.type === 'NEW_VERSION') &&
        parseBuildTimestamp(data.buildTimestamp) !== null
    )
}

export async function requestWorkerBuildTimestamp(
    worker: ServiceWorker | null,
): Promise<number | null> {
    if (!worker) {
        return null
    }

    return new Promise((resolve) => {
        const channel = new MessageChannel()
        const closePort = () => {
            channel.port1.close()
        }
        const timeoutId = window.setTimeout(() => {
            closePort()
            resolve(null)
        }, 1000)

        channel.port1.onmessage = (event: MessageEvent<unknown>) => {
            window.clearTimeout(timeoutId)
            closePort()

            if (!isServiceWorkerVersionMessage(event.data)) {
                resolve(null)
                return
            }

            resolve(parseBuildTimestamp(event.data.buildTimestamp))
        }

        try {
            worker.postMessage({ type: 'GET_BUILD_TIMESTAMP' }, [channel.port2])
        } catch (error) {
            window.clearTimeout(timeoutId)
            closePort()
            console.warn('[SW] Failed to request build timestamp:', error)
            resolve(null)
        }
    })
}

const UPDATE_NOTIFICATION_THRESHOLD_MS = 10 * 60 * 1000

export interface UpdateNotifierOptions {
    /** Whether a worker already controlled the page when it loaded: otherwise any install is the first. */
    hadActiveController: boolean
    /** The build time of this page's own code. */
    appBuildTimestamp: number | null
    /** The build time of a worker, asked of the worker itself. */
    readWorkerBuildTimestamp: (worker: ServiceWorker | null) => Promise<number | null>
    /** Tell the user that a newer version is available. */
    announce: () => void
}

/**
 * Decides, from each of the signals a worker update gives (installed, waiting, the controller
 * changed, the worker's own message), whether the user is to be told about a new version, and
 * tells them at most once. A first install is not an update, and a worker built less than ten
 * minutes after this page is the same release.
 */
export function createUpdateNotifier(options: UpdateNotifierOptions) {
    let hasShown = false

    // The two conditions that can end the matter, asked before the worker is read and again after
    // (another signal may have announced it while that was awaited).
    const shouldNotify = (source: string): boolean => {
        if (!options.hadActiveController) {
            console.log(`[SW] Skipping update notification from ${source} — first install`)
            return false
        }

        if (hasShown) {
            console.log(`[SW] Skipping update notification from ${source} — already shown`)
            return false
        }

        return true
    }

    return async function maybeShowUpdateNotification(
        source: string,
        worker: ServiceWorker | null,
        knownBuildTimestamp: number | null = null,
    ): Promise<void> {
        if (!shouldNotify(source)) return

        if (options.appBuildTimestamp === null) {
            console.warn(
                `[SW] Skipping update notification from ${source} — invalid app build timestamp`,
            )
            return
        }

        const serviceWorkerBuildTimestamp =
            knownBuildTimestamp ?? (await options.readWorkerBuildTimestamp(worker))

        if (serviceWorkerBuildTimestamp === null) {
            console.warn(
                `[SW] Skipping update notification from ${source} — failed to read service worker build timestamp`,
            )
            return
        }

        const buildDelta = serviceWorkerBuildTimestamp - options.appBuildTimestamp
        if (buildDelta <= UPDATE_NOTIFICATION_THRESHOLD_MS) {
            console.log(
                `[SW] Skipping update notification from ${source} — build delta ${buildDelta}ms is below threshold`,
            )
            return
        }

        if (!shouldNotify(source)) return

        hasShown = true
        console.log('[SW] Emitting update notification event')
        options.announce()
    }
}

export type MaybeShowUpdateNotification = ReturnType<typeof createUpdateNotifier>

/** Registers the worker and watches it for updates. */
export class ServiceWorkerManager {
    private registration: ServiceWorkerRegistration | null = null

    constructor(private readonly maybeShowUpdateNotification: MaybeShowUpdateNotification) {}

    async register(): Promise<ServiceWorkerRegistration | null> {
        if (!('serviceWorker' in navigator)) {
            console.warn('[SW] Service workers not supported')
            return null
        }

        try {
            console.log('[SW] Registering service worker...')

            this.registration = await navigator.serviceWorker.register('/service-worker.js', {
                scope: '/',
                updateViaCache: 'none',
            })

            console.log('[SW] Service worker registered:', this.registration)
            this.setupUpdateHandlers()
            return this.registration
        } catch (error) {
            console.error('[SW] Registration failed:', error)
            return null
        }
    }

    async checkForUpdates(): Promise<void> {
        if (!this.registration) return

        try {
            await this.registration.update()
            console.log('[SW] Update check completed')
        } catch (error) {
            console.error('[SW] Update check failed:', error)
        }
    }

    private watchWorker(worker: ServiceWorker | null): void {
        if (!worker) return
        worker.addEventListener('statechange', () => {
            // 'installed' fires when SW finishes installing and is ready
            // With skipWaiting() it immediately transitions to activating after this
            if (worker.state === 'installed') {
                console.log('[SW] New service worker installed')
                void this.maybeShowUpdateNotification('installed', worker)
            }
        })
    }

    private setupUpdateHandlers(): void {
        if (!this.registration) return

        const registration = this.registration
        registration.addEventListener('updatefound', () => {
            console.log('[SW] New service worker found')
            // Only notify on UPDATE (active SW exists), not on first install
            if (registration.active) {
                this.watchWorker(registration.installing)
            }
        })

        // Handle case where install was already in progress when register() resolved
        if (this.registration.active) {
            this.watchWorker(this.registration.installing)
        }

        // Handle case where SW is already in waiting state
        if (this.registration.waiting) {
            console.log('[SW] Service worker already waiting')
            void this.maybeShowUpdateNotification('waiting', this.registration.waiting)
        }
    }
}

async function initializeServiceWorker(
    maybeShowUpdateNotification: MaybeShowUpdateNotification,
): Promise<void> {
    console.log('initializeServiceWorker')
    try {
        if (!import.meta.env.PROD) {
            // In dev, unregister any previously installed SW to avoid stale cached HTML/asset responses.
            if ('serviceWorker' in navigator) {
                const hadController = Boolean(navigator.serviceWorker.controller)
                const registrations = await navigator.serviceWorker.getRegistrations()
                await Promise.all(registrations.map((registration) => registration.unregister()))
                if (hadController && sessionStorage.getItem('sw-dev-cleanup-reloaded') !== '1') {
                    sessionStorage.setItem('sw-dev-cleanup-reloaded', '1')
                    window.location.reload()
                    return
                }
                sessionStorage.removeItem('sw-dev-cleanup-reloaded')
            }
            return
        }

        const swManager = new ServiceWorkerManager(maybeShowUpdateNotification)
        const registration = await swManager.register()

        if (registration) {
            console.log('[SW] Service worker initialized successfully')

            // One update check at startup; later checks happen on each WS (re)connect.
            await swManager.checkForUpdates()
        }
    } catch (error) {
        console.error('[SW] Service worker initialization failed:', error)
    }
}

export interface StartServiceWorkerOptions {
    /** The build time of the page (`BUILD_TIMESTAMP`). */
    appBuildTimestamp: unknown
    /** Pass an error of the worker on to Sentry. */
    reportError: (error: Error, extra: ServiceWorkerErrorContext['extra']) => void
    /** Tell the user that a newer version is available. */
    announceUpdate: () => void
}

/**
 * Called once, as the page loads. The listeners go on at once (before `load`, or an event of a
 * fast worker could be missed); the registration waits for `load`.
 */
export function startServiceWorker(options: StartServiceWorkerOptions): void {
    // Was a worker active when the page loaded? Asked before any worker activity: the only reliable
    // signal. No worker (a first visit, or it was removed) means any install is the first one.
    const hadActiveController =
        'serviceWorker' in navigator && Boolean(navigator.serviceWorker.controller)

    const maybeShowUpdateNotification = createUpdateNotifier({
        hadActiveController,
        appBuildTimestamp: parseBuildTimestamp(options.appBuildTimestamp),
        readWorkerBuildTimestamp: requestWorkerBuildTimestamp,
        announce: options.announceUpdate,
    })

    if ('serviceWorker' in navigator && import.meta.env.PROD) {
        // controllerchange: the new worker took the page over (the most reliable signal);
        // `hadController` tells a first install from an update
        let hadController = Boolean(navigator.serviceWorker.controller)
        navigator.serviceWorker.addEventListener('controllerchange', () => {
            if (hadController) {
                console.log('[SW] Controller changed — new version is active')
                void maybeShowUpdateNotification(
                    'controllerchange',
                    navigator.serviceWorker.controller,
                )
            }
            hadController = true
        })

        // message: the worker reports a new version after dropping the old cache, or an error
        navigator.serviceWorker.addEventListener('message', (event: MessageEvent) => {
            console.log('[SW] Message:', event.data)
            if (isServiceWorkerErrorPayload(event.data)) {
                const swError = createServiceWorkerError(event.data.err)
                options.reportError(swError.error, swError.extra)
                return
            }

            if (isServiceWorkerVersionMessage(event.data) && event.data.type === 'NEW_VERSION') {
                void maybeShowUpdateNotification(
                    'message',
                    navigator.serviceWorker.controller,
                    parseBuildTimestamp(event.data.buildTimestamp),
                )
            }
        })
    }

    // Register after the page has loaded
    if (document.readyState === 'complete') {
        void initializeServiceWorker(maybeShowUpdateNotification)
    } else {
        window.addEventListener('load', () => {
            void initializeServiceWorker(maybeShowUpdateNotification)
        })
    }
}
