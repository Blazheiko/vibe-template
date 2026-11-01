/// <reference lib="webworker" />
import { API_PREFIX } from './utils/api-path'
import { isSameTarget, resolveNotificationTarget } from './utils/notification-target'
import {
    classifyRequest,
    isCacheableResponse,
    removeCachedApiResponses,
} from './utils/sw-request-policy'

declare const self: ServiceWorkerGlobalScope

// API requests live under the backend's API_PATH_PREFIX (code-issues item 73).
// The service worker never caches them: see utils/sw-request-policy.ts.

const cacheName = typeof BUILD_TIMESTAMP !== 'undefined' ? BUILD_TIMESTAMP : `now: ${Date.now()}`

const filesToCache = [
    '/',
    '/manifest.json',
    '/favicon.svg',
    '/icons/badge-72.png',
    '/icons/icon_192x192.png',
    '/icons/icon_512x512.png',
    '/icons/apple-touch-icon-120x120.png',
    '/icons/apple-touch-icon-152x152.png',
    '/icons/apple-touch-icon-167x167.png',
    '/icons/apple-touch-icon.png',
    '/icons/icon_maskable_192x192.png',
    '/icons/icon_maskable_512x512.png',
    '/splash/apple-splash-1170x2532.png',
    '/splash/apple-splash-1179x2556.png',
    '/splash/apple-splash-1290x2796.png',
    '/splash/splash-1080x2400.png',
    '/screenshots/account-settings-mobile.png',
    '/screenshots/navigation-mobile.png',
    '/audio/notification.mp3',
    '/audio/notification_1.mp3',
    '/audio/click-button-140881.mp3',
    '/audio/pdjyznja.mp3',
]

const serviceWorkerErrorQueueCacheName = '__vibe_template_sw_error_queue__'
const serviceWorkerErrorQueueRequestPrefix = '/__vibe_template_sw_error_queue__/'
const serviceWorkerErrorQueueMaxItems = 20
const serviceWorkerErrorQueueTtlMs = 24 * 60 * 60 * 1000

interface ServiceWorkerErrorPayload {
    type: 'SW_ERROR'
    err: {
        message: string
        stack?: string
        name?: string
    }
}

interface QueuedServiceWorkerErrorEntry {
    queuedAt: number
    payload: ServiceWorkerErrorPayload
}

/** Every cache write goes through here: only responses the server allows to be stored. */
async function putIfCacheable(
    cache: Cache,
    request: RequestInfo,
    response: Response,
): Promise<void> {
    if (isCacheableResponse(response)) {
        await cache.put(request, response)
    }
}

function cacheResponse(request: Request, response: Response): void {
    if (!isCacheableResponse(response)) return
    const responseClone = response.clone()
    void caches
        .open(cacheName)
        .then(function (cache) {
            return putIfCacheable(cache, request, responseClone)
        })
        .catch(function (cacheError: unknown) {
            void reportServiceWorkerError(cacheError)
        })
}

async function reportServiceWorkerError(error: unknown): Promise<void> {
    const normalizedError =
        error instanceof Error
            ? error
            : new Error(typeof error === 'string' ? error : 'Service worker error')

    const payload: ServiceWorkerErrorPayload = {
        type: 'SW_ERROR',
        err: {
            message: normalizedError.message,
            stack: normalizedError.stack,
            name: normalizedError.name,
        },
    }

    const sentCount = await sendMessageToAll(payload)
    if (sentCount === 0) {
        await queueServiceWorkerError(payload)
    }
}

async function reportServiceWorkerErrorAndFallback<T>(
    error: unknown,
    fallback: T | Promise<T>,
): Promise<T> {
    await reportServiceWorkerError(error)
    return await fallback
}

async function queueServiceWorkerError(payload: ServiceWorkerErrorPayload): Promise<void> {
    const cache = await caches.open(serviceWorkerErrorQueueCacheName)
    await pruneQueuedServiceWorkerErrors(cache)
    // randomUUID is missing in older service worker runtimes.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    const requestId = `${Date.now()}-${crypto.randomUUID?.() ?? Math.random().toString(16).slice(2)}`
    const request = new Request(`${serviceWorkerErrorQueueRequestPrefix}${requestId}`)
    await cache.put(
        request,
        new Response(
            JSON.stringify({
                queuedAt: Date.now(),
                payload,
            } satisfies QueuedServiceWorkerErrorEntry),
            {
                headers: {
                    'Content-Type': 'application/json',
                },
            },
        ),
    )
}

async function pruneQueuedServiceWorkerErrors(cache: Cache): Promise<void> {
    const queue = await readQueuedServiceWorkerErrors(cache)
    const now = Date.now()
    const kept = queue.filter((entry) => now - entry.queuedAt <= serviceWorkerErrorQueueTtlMs)
    const expired = queue.filter((entry) => now - entry.queuedAt > serviceWorkerErrorQueueTtlMs)

    await Promise.all(expired.map((entry) => cache.delete(entry.request)))

    if (kept.length <= serviceWorkerErrorQueueMaxItems) {
        return
    }

    const sorted = [...kept].sort((a, b) => b.queuedAt - a.queuedAt)
    const overflow = sorted.slice(serviceWorkerErrorQueueMaxItems)
    await Promise.all(overflow.map((entry) => cache.delete(entry.request)))
}

function isQueuedServiceWorkerErrorRequest(request: Request): boolean {
    return new URL(request.url).pathname.startsWith(serviceWorkerErrorQueueRequestPrefix)
}

async function readQueuedServiceWorkerErrors(cache: Cache): Promise<
    {
        request: Request
        queuedAt: number
        payload: ServiceWorkerErrorPayload
    }[]
> {
    const requests = await cache.keys()
    const entries: {
        request: Request
        queuedAt: number
        payload: ServiceWorkerErrorPayload
    }[] = []

    for (const request of requests) {
        if (!isQueuedServiceWorkerErrorRequest(request)) {
            continue
        }

        const response = await cache.match(request)
        if (!response) {
            continue
        }

        try {
            const raw: unknown = await response.clone().json()
            if (typeof raw !== 'object' || raw === null) continue
            const queued = raw as Partial<QueuedServiceWorkerErrorEntry>
            if (
                typeof queued.queuedAt !== 'number' ||
                typeof queued.payload !== 'object' ||
                // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- JSON from the cache
                queued.payload === null
            ) {
                continue
            }

            entries.push({
                request,
                queuedAt: queued.queuedAt,
                payload: queued.payload,
            })
        } catch (error: unknown) {
            console.error('[ServiceWorker] Failed to read queued error', error)
        }
    }

    return entries
}

async function flushQueuedServiceWorkerErrors(): Promise<void> {
    const cache = await caches.open(serviceWorkerErrorQueueCacheName)
    await pruneQueuedServiceWorkerErrors(cache)
    const queue = await readQueuedServiceWorkerErrors(cache)

    for (const entry of queue) {
        const sentCount = await sendMessageToAll(entry.payload)
        if (sentCount > 0) {
            await cache.delete(entry.request)
        }
    }
}

self.addEventListener('install', function (e: ExtendableEvent) {
    console.log('[ServiceWorker] Install')

    e.waitUntil(
        (async () => {
            try {
                const cache = await caches.open(cacheName)
                console.log('[ServiceWorker] Caching app shell')
                // Cache all files individually so a single 404 doesn't abort install
                await Promise.allSettled(
                    filesToCache.map((url) =>
                        fetch(url)
                            .then((r) => putIfCacheable(cache, url, r))
                            .catch(() => undefined),
                    ),
                )
                await self.skipWaiting()
            } catch (error) {
                await reportServiceWorkerError(error)
                throw error
            }
        })(),
    )
})

self.addEventListener('activate', function (e: ExtendableEvent) {
    console.log('[ServiceWorker] Activate')
    e.waitUntil(
        (async () => {
            try {
                const keyList = await caches.keys()
                const hasOldCache = keyList.some(
                    (key) => key !== cacheName && key !== serviceWorkerErrorQueueCacheName,
                )
                await Promise.all(
                    keyList
                        .filter(
                            (key) => key !== cacheName && key !== serviceWorkerErrorQueueCacheName,
                        )
                        .map(function (key) {
                            console.log('[ServiceWorker] Removing old cache', key)
                            return caches.delete(key)
                        }),
                )
                // An older worker may have cached API responses: drop them.
                await removeCachedApiResponses(caches, cacheName, API_PREFIX)
                await self.clients.claim()
                if (hasOldCache) {
                    void sendMessageToAll({
                        type: 'NEW_VERSION',
                        buildTimestamp: BUILD_TIMESTAMP,
                    })
                }
            } catch (error) {
                await reportServiceWorkerError(error)
                throw error
            }
        })(),
    )
})

self.addEventListener('fetch', function (e: FetchEvent) {
    try {
        const strategy = classifyRequest({
            url: e.request.url,
            method: e.request.method,
            destination: e.request.destination,
            mode: e.request.mode,
            swOrigin: self.location.origin,
            apiPrefix: API_PREFIX,
        })

        // Mutations, the API, other origins and network-only scripts: no respondWith,
        // the browser goes to the network itself and nothing is cached.
        if (strategy === 'bypass') {
            return
        }

        if (strategy === 'cache-first') {
            e.respondWith(
                caches
                    .match(e.request)
                    .then(function (response) {
                        return (
                            response ??
                            fetch(e.request).then(function (fetchResponse) {
                                cacheResponse(e.request, fetchResponse)
                                return fetchResponse
                            })
                        )
                    })
                    .catch(function (error: unknown) {
                        return reportServiceWorkerErrorAndFallback(
                            error,
                            new Response('', { status: 503, statusText: 'Service Unavailable' }),
                        )
                    }),
            )
            return
        }

        if (strategy === 'network-first') {
            e.respondWith(
                fetch(e.request)
                    .then(function (response) {
                        cacheResponse(e.request, response)
                        return response
                    })
                    .catch(function (error: unknown) {
                        return reportServiceWorkerErrorAndFallback(
                            error,
                            caches.match(e.request).then(function (cachedResponse) {
                                if (cachedResponse) return cachedResponse
                                return caches.match('/').then(function (indexResponse) {
                                    return indexResponse ?? new Response('Offline', { status: 503 })
                                })
                            }),
                        )
                    }),
            )
            return
        }

        // stale-while-revalidate
        e.respondWith(
            caches.match(e.request, { ignoreSearch: true }).then(function (response) {
                const fetchPromise = fetch(e.request)
                    .then(function (networkResponse) {
                        cacheResponse(e.request, networkResponse)
                        return networkResponse
                    })
                    .catch(function (error: unknown) {
                        return reportServiceWorkerErrorAndFallback(
                            error,
                            new Response('', {
                                status: 503,
                                statusText: 'Service Unavailable',
                            }),
                        )
                    })

                return response ?? fetchPromise
            }),
        )
    } catch (error: unknown) {
        void reportServiceWorkerError(error)
    }
})

self.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
    void reportServiceWorkerError(event.reason)
})

self.addEventListener('error', (event: Event) => {
    const errorEvent = event as ErrorEvent
    void reportServiceWorkerError(errorEvent.error || errorEvent.message)
})

// --- events from/to js application ---
async function sendMessageToAll(msg: unknown): Promise<number> {
    try {
        const clients = await self.clients.matchAll()
        clients.forEach((client) => {
            client.postMessage(msg)
        })
        return clients.length
    } catch (error: unknown) {
        console.error('[ServiceWorker] Failed to broadcast message', error)
        return 0
    }
}

// --- message from js application ---
self.addEventListener('message', (event: ExtendableMessageEvent) => {
    try {
        void flushQueuedServiceWorkerErrors()

        if (event.data?.type === 'GET_BUILD_TIMESTAMP') {
            const buildInfo = {
                type: 'BUILD_INFO',
                buildTimestamp: BUILD_TIMESTAMP,
            }

            if (event.ports[0]) {
                event.ports[0].postMessage(buildInfo)
                return
            }

            if (event.source && 'postMessage' in event.source) {
                event.source.postMessage(buildInfo)
                return
            }
        }

        if (event.data) {
            if (event.data.message) {
                console.log('SW MESSAGE: ', event.data.message, event.data.data)
            }
        }
    } catch (error) {
        void reportServiceWorkerError(error)
    }
})

// --- web push notifications ---
interface ServiceWorkerNotificationAction {
    action: string
    title: string
}

interface ServiceWorkerNotificationOptions {
    body?: string
    icon?: string
    badge?: string
    vibrate?: number[]
    data?: Record<string, unknown>
    requireInteraction?: boolean
    actions?: ServiceWorkerNotificationAction[]
    title?: string
}

interface NotificationPayload {
    notification?: ServiceWorkerNotificationOptions
    data?: Record<string, unknown>
}

self.addEventListener('push', (event: PushEvent) => {
    console.log('[ServiceWorker] Push received:', event)

    let options: ServiceWorkerNotificationOptions = {
        body: 'You have a new message',
        icon: '/icons/icon_192x192.png',
        badge: '/icons/badge-72.png',
        vibrate: [200, 100, 200],
        data: {
            url: '/',
        },
        requireInteraction: false,
        actions: [
            {
                action: 'open',
                title: 'Open App',
            },
            {
                action: 'close',
                title: 'Close',
            },
        ],
    }

    if (event.data) {
        try {
            const payload: NotificationPayload = event.data.json()
            if (payload.notification) {
                options = { ...options, ...payload.notification }
            }
            if (payload.data) {
                options.data = { ...options.data, ...payload.data }
            }
        } catch {
            console.log('[ServiceWorker] Push payload not JSON:', event.data.text())
            options.body = event.data.text() || options.body
        }
    }

    const title = options.title || 'Easy Chat'

    event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', (event: NotificationEvent) => {
    console.log('[ServiceWorker] Notification clicked:', event)
    event.notification.close()

    // The address is part of the push payload: only a page of this application is opened.
    const url = resolveNotificationTarget(event.notification.data?.url, self.location.origin)

    if (event.action === 'close') {
        return
    }

    event.waitUntil(
        self.clients
            .matchAll({
                type: 'window',
                includeUncontrolled: true,
            })
            .then((clientList) => {
                // Проверяем, есть ли уже открытое окно приложения
                for (const client of clientList) {
                    if (isSameTarget(client.url, url) && 'focus' in client) {
                        return client.focus()
                    }
                }
                // Если нет открытого окна, открываем новое
                // openWindow is missing in some browsers.
                // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
                if (self.clients.openWindow) {
                    return self.clients.openWindow(url)
                }
            }),
    )
})

// Обработка закрытия уведомления
self.addEventListener('notificationclose', (event: NotificationEvent) => {
    console.log('[ServiceWorker] Notification closed:', event)
})
