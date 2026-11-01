import './assets/main.css'
import './styles.css'
import './shared-components.css'

import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import router from './router'
import { useEventBus } from '@/utils/event-bus'
import { i18n } from '@/plugins/i18n'
import { sentryService as sentry } from '@/utils/sentry-service'
import { initializePwaInstallTracking } from '@/utils/pwa-install'
import { initLocaleStandalone } from '@/composables/useLocale'
import { isNavigationFailure } from 'vue-router'

initializePwaInstallTracking()

void bootstrap()

async function bootstrap() {
    await initLocaleStandalone()

    const app = createApp(App)

    app.use(createPinia())
    app.use(router)
    app.use(i18n)
    router.onError((error, to) => {
        if (isNavigationFailure(error)) {
            return
        }

        sentry.captureException(error, {
            extra: {
                targetRoute: to.fullPath || to.path || '',
            },
        })
    })

    sentry.init(app, router)

    app.mount('#app')
}

interface ServiceWorkerErrorPayload {
    type: 'SW_ERROR'
    err:
        | {
              message?: string
              stack?: string
              name?: string
          }
        | Error
}

interface ServiceWorkerErrorContext {
    error: Error
    extra: {
        swStack?: string
        swName?: string
    }
}

function isServiceWorkerErrorPayload(value: unknown): value is ServiceWorkerErrorPayload {
    if (!value || typeof value !== 'object') {
        return false
    }

    const data = value as Record<string, unknown>
    if (data.type !== 'SW_ERROR' || !data.err || typeof data.err !== 'object') {
        return false
    }

    return true
}

function createServiceWorkerError(
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

interface ServiceWorkerVersionMessage {
    type: 'BUILD_INFO' | 'NEW_VERSION'
    buildTimestamp: string
}

const UPDATE_NOTIFICATION_THRESHOLD_MS = 10 * 60 * 1000
const APP_BUILD_TIMESTAMP = parseBuildTimestamp(BUILD_TIMESTAMP)

let hasShownUpdateNotification = false

function parseBuildTimestamp(value: unknown): number | null {
    if (typeof value !== 'string' && typeof value !== 'number') {
        return null
    }

    const timestamp = Number(value)
    return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null
}

function isServiceWorkerVersionMessage(value: unknown): value is ServiceWorkerVersionMessage {
    if (!value || typeof value !== 'object') {
        return false
    }

    const data = value as Record<string, unknown>
    return (
        (data.type === 'BUILD_INFO' || data.type === 'NEW_VERSION') &&
        parseBuildTimestamp(data.buildTimestamp) !== null
    )
}

async function requestWorkerBuildTimestamp(worker: ServiceWorker | null): Promise<number | null> {
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

// Service Worker Management
class ServiceWorkerManager {
    private registration: ServiceWorkerRegistration | null = null

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
                void maybeShowUpdateNotification('installed', worker)
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
            void maybeShowUpdateNotification('waiting', this.registration.waiting)
        }
    }
}

// Инициализация Service Worker
async function initializeServiceWorker() {
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

        const swManager = new ServiceWorkerManager()
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

// Был ли SW активен при загрузке страницы?
// Проверяется ДО любой SW-активности — единственный надёжный сигнал.
// null = первый визит (или SW был удалён) → любая установка = начальная, не обновление.
const hadActiveController =
    'serviceWorker' in navigator && Boolean(navigator.serviceWorker.controller)

// Функция показа уведомления о новой версии
function showUpdateNotification() {
    if (!hadActiveController) {
        console.log('[SW] Skipping update notification — first install, not an update')
        return
    }

    if (hasShownUpdateNotification) {
        console.log('[SW] Update notification already shown')
        return
    }

    hasShownUpdateNotification = true
    console.log('[SW] Emitting update notification event')
    const eventBus = useEventBus()
    eventBus.emit('update_available')
}

async function maybeShowUpdateNotification(
    source: string,
    worker: ServiceWorker | null,
    knownBuildTimestamp: number | null = null,
): Promise<void> {
    if (!hadActiveController) {
        console.log(`[SW] Skipping update notification from ${source} — first install`)
        return
    }

    if (hasShownUpdateNotification) {
        console.log(`[SW] Skipping update notification from ${source} — already shown`)
        return
    }

    if (APP_BUILD_TIMESTAMP === null) {
        console.warn(
            `[SW] Skipping update notification from ${source} — invalid app build timestamp`,
        )
        return
    }

    const serviceWorkerBuildTimestamp =
        knownBuildTimestamp ?? (await requestWorkerBuildTimestamp(worker))

    if (serviceWorkerBuildTimestamp === null) {
        console.warn(
            `[SW] Skipping update notification from ${source} — failed to read service worker build timestamp`,
        )
        return
    }

    const buildDelta = serviceWorkerBuildTimestamp - APP_BUILD_TIMESTAMP
    if (buildDelta <= UPDATE_NOTIFICATION_THRESHOLD_MS) {
        console.log(
            `[SW] Skipping update notification from ${source} — build delta ${buildDelta}ms is below threshold`,
        )
        return
    }

    showUpdateNotification()
}

// Слушатели SW регистрируются СРАЗУ — до load события, чтобы не пропустить
// события которые могут сработать до полной загрузки страницы
if ('serviceWorker' in navigator && import.meta.env.PROD) {
    // controllerchange: новый SW взял управление страницей (самый надёжный способ)
    // hadController позволяет отличить первую установку от обновления
    let hadController = Boolean(navigator.serviceWorker.controller)
    navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (hadController) {
            console.log('[SW] Controller changed — new version is active')
            void maybeShowUpdateNotification('controllerchange', navigator.serviceWorker.controller)
        }
        hadController = true
    })

    // message: SW сообщает о новой версии после удаления старого кеша
    navigator.serviceWorker.addEventListener('message', (event: MessageEvent) => {
        console.log('[SW] Message:', event.data)
        if (isServiceWorkerErrorPayload(event.data)) {
            const swError = createServiceWorkerError(event.data.err)
            sentry.captureException(swError.error, {
                tags: {
                    source: 'service-worker',
                },
                extra: swError.extra,
            })
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

// Регистрацию SW запускаем после полной загрузки страницы
if (document.readyState === 'complete') {
    void initializeServiceWorker()
} else {
    window.addEventListener('load', () => {
        void initializeServiceWorker()
    })
}
