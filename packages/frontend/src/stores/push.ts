import { ref } from 'vue'
import { defineStore } from 'pinia'
import { pushSubscriptionApi } from '@/utils/api'
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
export const usePushStore = defineStore('push', () => {
    const notificationPermission = ref<NotificationPermission>('default')
    const pushSubscription = ref<PushSubscription | null>(null)
    const isSubscribedToPush = ref(false)
    const pushSubscriptionId = ref<string | null>(null)
    const pushSubscriptionsResource = createResource(60_000)

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
            const registration = await navigator.serviceWorker.ready

            // Проверяем существующую подписку
            const existingSubscription = await registration.pushManager.getSubscription()
            if (existingSubscription) {
                pushSubscription.value = existingSubscription
                isSubscribedToPush.value = true
                return existingSubscription
            }

            // Получаем VAPID ключ
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

            // Создаем новую подписку
            const subscription = await registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(vapidKey).buffer as ArrayBuffer,
            })

            pushSubscription.value = subscription
            isSubscribedToPush.value = true

            // Отправляем подписку на сервер
            await sendSubscriptionToServer(subscription)

            return subscription
        } catch (error) {
            console.error('Failed to subscribe to push notifications:', error)
            if (error instanceof Error && error.message.includes('VAPID')) {
                // Показываем пользователю понятное сообщение об ошибке VAPID
                console.warn('⚠️ Push-уведомления временно недоступны (VAPID ключ не настроен)')
            }
            return null
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
            if (response.data?.vapidPublicKey) {
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

            const data = response.data as Record<string, unknown> | null
            if (data !== null && typeof data === 'object' && 'subscription' in data) {
                const sub = data.subscription as { id?: string }
                if (sub.id !== undefined) {
                    pushSubscriptionId.value = sub.id
                }
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

                const rawData = response.data as Record<string, unknown> | null
                const subscriptions = (
                    rawData !== null && Array.isArray(rawData)
                        ? rawData
                        : Array.isArray(rawData?.subscriptions)
                          ? (rawData.subscriptions as {
                                id: string
                                isActive: boolean
                                endpoint: string
                            }[])
                          : []
                ) as { id: string; isActive: boolean; endpoint: string }[]

                pushSubscriptionId.value = null
                isSubscribedToPush.value = false
                pushSubscription.value = null

                if (subscriptions.length > 0) {
                    const activeSubscription = subscriptions.find((sub) => sub.isActive)
                    if (activeSubscription) {
                        pushSubscriptionId.value = activeSubscription.id
                        isSubscribedToPush.value = true

                        if ('serviceWorker' in navigator) {
                            const registration = await navigator.serviceWorker.ready
                            const currentSubscription =
                                await registration.pushManager.getSubscription()

                            if (currentSubscription?.endpoint === activeSubscription.endpoint) {
                                pushSubscription.value = currentSubscription
                            }
                        }
                    }
                }
            })
        } catch (error) {
            if (isAbortError(error)) {
                return
            }
            console.error('Error loading user subscriptions:', error)
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
        resetPushSubscriptionState,
    }
})
