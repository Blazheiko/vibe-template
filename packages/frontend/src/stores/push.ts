import { ref } from 'vue'
import { defineStore } from 'pinia'
import { pushSubscriptionApi } from '@/utils/api'
import type { GetSubscriptionsResponse } from 'shared/responses'
import { apiPath } from '@/utils/api-path'
import { createResource, isAbortError } from '@/utils/resource-state'
import { getResponseMessage } from '@/utils/response-normalizer'
import {
    arrayBufferToBase64,
    getBrowserInfo,
    getDeviceType,
    getOSInfo,
    isValidVapidKey,
    urlBase64ToUint8Array,
} from '@/utils/push-device'

// Push notifications: the browser's permission, this browser's subscription, and its record on
// the server. The user-agent and key helpers are in utils/push-device.ts.
//
// The browser keeps its subscription across sign-outs and accounts, and the server sends to
// whoever owns the record, so the two are kept in step (feat-148): "enabled" means this browser's
// subscription is an active record of the signed-in account; a sign-out releases it; a
// subscription another account left in this browser is removed at the next sign-in.

/** How long a sign-out waits for the push service and the server before it goes on. */
const RELEASE_TIMEOUT_MS = 3000

interface ServerSubscription {
    id: string
    isActive: boolean
    endpoint: string
}

/**
 * One spelling for both sides: the server stores the endpoint with upper-case percent escapes
 * and a lower-case host (push-endpoint-policy.ts), the browser hands out its own.
 */
const endpointKey = (endpoint: string): string => {
    try {
        return new URL(endpoint).href.replace(/%[0-9a-f]{2}/gi, (escape) => escape.toUpperCase())
    } catch {
        return endpoint
    }
}

const isSameEndpoint = (a: string, b: string): boolean => endpointKey(a) === endpointKey(b)

/**
 * This browser's subscription, or null. Unlike `serviceWorker.ready` it does not wait for a
 * service worker that was never registered (a dev server): a sign-out must not hang on it.
 */
const currentBrowserSubscription = async (): Promise<PushSubscription | null> => {
    if (!('serviceWorker' in navigator)) return null
    const registration = await navigator.serviceWorker.getRegistration()
    if (registration === undefined) return null
    return await registration.pushManager.getSubscription()
}

/** The subscriptions of an answer of the list route, as its contract types it. */
const serverSubscriptionsOf = (data: GetSubscriptionsResponse | null): ServerSubscription[] =>
    data?.status === 'success' ? (data.subscriptions ?? []) : []
export const usePushStore = defineStore('push', () => {
    const notificationPermission = ref<NotificationPermission>('default')
    const pushSubscription = ref<PushSubscription | null>(null)
    const isSubscribedToPush = ref(false)
    const pushSubscriptionId = ref<string | null>(null)
    const pushSubscriptionsResource = createResource(60_000)
    // True while subscribeToPush is between the browser's subscription and the server's answer:
    // that subscription is not a leftover of another account.
    let isSyncingSubscription = false

    const initNotifications = () => {
        if ('Notification' in window) {
            notificationPermission.value = Notification.permission
        }
    }

    // Запрос разрешения на уведомления
    const requestNotificationPermission = async (): Promise<NotificationPermission> => {
        if (!('Notification' in window)) {
            console.warn('This browser does not support notifications')
            return 'denied'
        }

        const permission = await Notification.requestPermission()
        notificationPermission.value = permission
        return permission
    }

    const ensureNotificationPermission = async (): Promise<boolean> => {
        if (notificationPermission.value !== 'granted') {
            const permission = await requestNotificationPermission()
            return permission === 'granted'
        }
        return true
    }

    // Подписка на push уведомления
    const subscribeToPush = async (): Promise<PushSubscription | null> => {
        if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
            console.warn('Push messaging is not supported')
            return null
        }

        try {
            isSyncingSubscription = true
            const registration = await navigator.serviceWorker.ready

            // The browser may already have a subscription: one whose record the server never
            // got (a failed request) or one made under another account.
            let subscription = await registration.pushManager.getSubscription()

            if (subscription === null) {
                const vapidKey = await getVapidPublicKey()
                if (!isValidVapidKey(vapidKey)) {
                    console.error('❌ VAPID ключ не настроен или невалиден')
                    console.info('💡 Для настройки VAPID ключа:')
                    console.info('1. Создайте VAPID ключи: npx web-push generate-vapid-keys')
                    console.info(
                        '2. Добавьте публичный ключ в переменную окружения VITE_VAPID_PUBLIC_KEY',
                    )
                    console.info(
                        `3. Или настройте эндпоинт ${apiPath('push-subscriptions/vapid-public-key')} на сервере`,
                    )
                    throw new Error('VAPID ключ не настроен')
                }

                subscription = await registration.pushManager.subscribe({
                    userVisibleOnly: true,
                    applicationServerKey: urlBase64ToUint8Array(vapidKey).buffer as ArrayBuffer,
                })
            }

            // The server sends the notifications: the subscription is enabled only once the
            // server has it for this account. A refusal leaves it disabled, and the next
            // attempt posts the same subscription again.
            await sendSubscriptionToServer(subscription)

            pushSubscription.value = subscription
            isSubscribedToPush.value = true

            return subscription
        } catch (error) {
            console.error('Failed to subscribe to push notifications:', error)
            if (error instanceof Error && error.message.includes('VAPID')) {
                // Показываем пользователю понятное сообщение об ошибке VAPID
                console.warn('⚠️ Push-уведомления временно недоступны (VAPID ключ не настроен)')
            }
            return null
        } finally {
            isSyncingSubscription = false
        }
    }

    // Отписка от push уведомлений
    const unsubscribeFromPush = async (): Promise<boolean> => {
        if (!pushSubscription.value) {
            return true
        }

        try {
            const success = await pushSubscription.value.unsubscribe()
            if (success) {
                // Уведомляем сервер об отписке
                await removeSubscriptionFromServer()

                pushSubscription.value = null
                isSubscribedToPush.value = false
            }
            return success
        } catch (error) {
            console.error('Failed to unsubscribe from push notifications:', error)
            return false
        }
    }

    // Получение VAPID публичного ключа с сервера (единственный источник)
    const getVapidPublicKey = async (): Promise<string | null> => {
        try {
            const response = await pushSubscriptionApi.getVapidPublicKey()
            if (response.data?.status === 'success' && response.data.vapidPublicKey) {
                return response.data.vapidPublicKey
            }
        } catch (error) {
            console.warn('Failed to get VAPID key from server:', error)
        }

        return null
    }

    // Отправка подписки на сервер
    const sendSubscriptionToServer = async (subscription: PushSubscription): Promise<void> => {
        try {
            const browserInfo = getBrowserInfo(navigator.userAgent)
            const osInfo = getOSInfo(navigator.userAgent)

            const subscriptionData = {
                endpoint: subscription.endpoint,
                p256dhKey: arrayBufferToBase64(subscription.getKey('p256dh')),
                authKey: arrayBufferToBase64(subscription.getKey('auth')),
                userAgent: navigator.userAgent,
                deviceType: getDeviceType(navigator.userAgent),
                browserName: browserInfo.name,
                browserVersion: browserInfo.version,
                osName: osInfo.name,
                osVersion: osInfo.version,
                notificationTypes: ['mention', 'system'] as ('mention' | 'system')[],
                timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            }

            const response = await pushSubscriptionApi.createSubscription(subscriptionData)

            if (response.error) {
                console.error('Failed to save subscription to server:', response.error)
                throw new Error(
                    getResponseMessage(
                        response.data,
                        response.error.message || 'Push subscription request failed',
                    ),
                )
            }

            if (response.data?.status === 'success' && response.data.subscription !== undefined) {
                pushSubscriptionId.value = response.data.subscription.id
            }
        } catch (error) {
            console.error('Error sending subscription to server:', error)
            throw error
        }
    }

    // Удаление подписки с сервера
    const removeSubscriptionFromServer = async (): Promise<void> => {
        try {
            if (pushSubscriptionId.value !== null) {
                const response = await pushSubscriptionApi.deleteSubscription(
                    pushSubscriptionId.value,
                )

                if (response.error) {
                    console.error('Failed to remove subscription from server:', response.error)
                    throw new Error(
                        getResponseMessage(
                            response.data,
                            response.error.message || 'Push subscription request failed',
                        ),
                    )
                }

                pushSubscriptionId.value = null
            }
        } catch (error) {
            console.error('Error removing subscription from server:', error)
            throw error
        }
    }

    // Загрузка существующих подписок пользователя
    const ensurePushSubscriptionsLoaded = async (): Promise<void> => {
        try {
            await pushSubscriptionsResource.ensureLoaded(async () => {
                const response = await pushSubscriptionApi.getSubscriptions()

                if (response.error) {
                    console.error('Failed to load user subscriptions:', response.error)
                    throw new Error(
                        getResponseMessage(
                            response.data,
                            response.error.message || 'Failed to load push subscriptions',
                        ),
                    )
                }

                const subscriptions = serverSubscriptionsOf(response.data)
                const current = await currentBrowserSubscription()
                const record =
                    current === null
                        ? undefined
                        : subscriptions.find((sub) =>
                              isSameEndpoint(sub.endpoint, current.endpoint),
                          )

                pushSubscriptionId.value = null
                isSubscribedToPush.value = false
                pushSubscription.value = null

                if (current === null) return

                if (record === undefined) {
                    // Not a subscription of this account: another account left it in this
                    // browser. It goes, so its notifications stop arriving here; this account
                    // enables push itself.
                    if (!isSyncingSubscription) {
                        await current.unsubscribe().catch((error: unknown) => {
                            console.warn('Failed to remove a leftover push subscription:', error)
                        })
                    }
                    return
                }

                pushSubscriptionId.value = record.id
                if (record.isActive) {
                    pushSubscription.value = current
                    isSubscribedToPush.value = true
                }
            })
        } catch (error) {
            if (isAbortError(error)) {
                return
            }
            console.error('Error loading user subscriptions:', error)
        }
    }

    /**
     * A sign-out: the record on the server and the browser's subscription both go, so the
     * account's notifications stop arriving in this browser. Best effort and bounded: neither a
     * failure nor a slow push service holds the sign-out, and what is left behind is removed
     * when another account signs in (ensurePushSubscriptionsLoaded).
     */
    const releaseBrowserSubscription = async (): Promise<void> => {
        const release = async (): Promise<void> => {
            const current = await currentBrowserSubscription()
            if (current === null) return

            try {
                let id = pushSubscriptionId.value
                if (id === null) {
                    const response = await pushSubscriptionApi.getSubscriptions()
                    id =
                        serverSubscriptionsOf(response.data).find((sub) =>
                            isSameEndpoint(sub.endpoint, current.endpoint),
                        )?.id ?? null
                }
                if (id !== null) {
                    const response = await pushSubscriptionApi.deleteSubscription(id)
                    if (response.error) {
                        console.warn('Failed to remove the push subscription:', response.error)
                    }
                }
            } catch (error) {
                console.warn('Failed to remove the push subscription:', error)
            }

            await current.unsubscribe()
        }

        let timer: ReturnType<typeof setTimeout> | undefined
        try {
            await Promise.race([
                release(),
                new Promise<void>((resolve) => {
                    timer = setTimeout(resolve, RELEASE_TIMEOUT_MS)
                }),
            ])
        } catch (error) {
            console.warn('Failed to release the push subscription:', error)
        } finally {
            clearTimeout(timer)
        }
    }

    const resetPushSubscriptionState = (): void => {
        pushSubscription.value = null
        isSubscribedToPush.value = false
        pushSubscriptionId.value = null
        pushSubscriptionsResource.reset()
    }

    // Initialise the permission when the store is created
    initNotifications()

    return {
        notificationPermission,
        pushSubscription,
        isSubscribedToPush,
        pushSubscriptionId,
        requestNotificationPermission,
        ensureNotificationPermission,
        subscribeToPush,
        unsubscribeFromPush,
        ensurePushSubscriptionsLoaded,
        releaseBrowserSubscription,
        resetPushSubscriptionState,
    }
})
