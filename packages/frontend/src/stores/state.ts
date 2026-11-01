import { ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { pushSubscriptionApi } from '@/utils/api'
import { apiPath } from '@/utils/api-path'
import { createResource, isAbortError } from '@/utils/resource-state'
import { isPwaMode } from '@/utils/app-type'
import { getResponseMessage } from '@/utils/response-normalizer'

export interface StorageConfig {
    cdnUrl: string
    s3Prefix: string
    s3StaticDataPrefix: string
    s3DynamicDataPrefix: string
}

export const useStateStore = defineStore('state', () => {
    const theme = localStorage.getItem('theme')
    const darkMode = ref(theme === 'dark')
    const colorTheme = ref(localStorage.getItem('colorTheme') || 'rose')
    const savedFontSize = Number(localStorage.getItem('fontSize'))
    const fontSize = ref(
        Number.isFinite(savedFontSize) ? Math.min(Math.max(savedFontSize, 14), 20) : 16,
    )
    // const isLoading = ref(false)
    // const isOffline = ref(false)
    // const isMenuOpen = ref(false)
    const windowWidth = ref(window.innerWidth)
    const isMobile = ref(window.innerWidth <= 768)
    const isPWAMode = ref(false)

    // Push notifications state
    const notificationPermission = ref<NotificationPermission>('default')
    const pushSubscription = ref<PushSubscription | null>(null)
    const isSubscribedToPush = ref(false)
    const pushSubscriptionId = ref<string | null>(null)
    const pushSubscriptionsResource = createResource(60_000)
    const storageConfig = ref<StorageConfig>({
        cdnUrl: '',
        s3Prefix: '',
        s3StaticDataPrefix: '',
        s3DynamicDataPrefix: '',
    })

    const handleResize = () => {
        windowWidth.value = window.innerWidth
        isMobile.value = window.innerWidth <= 768
    }

    const setStorageConfig = (config: Partial<StorageConfig>) => {
        storageConfig.value = {
            ...storageConfig.value,
            ...config,
        }
    }

    const normalizeUrl = (value: string): string => {
        if (!value) return ''
        return value.endsWith('/') ? value.slice(0, -1) : value
    }

    const normalizePathSegment = (value: string): string => {
        return value.trim().replace(/^\/+|\/+$/g, '')
    }

    const hasPathPrefix = (value: string, prefix: string): boolean => {
        if (!value || !prefix) return false
        return value === prefix || value.startsWith(`${prefix}/`)
    }

    const getStorageFileUrl = (src: string): string => {
        if (src.startsWith('http://') || src.startsWith('https://')) {
            return src
        }

        const cleanSrc = src.trim().replace(/^\/+/, '')
        const dynamicPrefix = normalizePathSegment(storageConfig.value.s3DynamicDataPrefix)
        const rootPrefix = normalizePathSegment(storageConfig.value.s3Prefix)
        let fullPath = cleanSrc

        if (dynamicPrefix && !hasPathPrefix(fullPath, dynamicPrefix)) {
            fullPath = `${dynamicPrefix}/${fullPath}`
        }
        if (rootPrefix && !hasPathPrefix(fullPath, rootPrefix)) {
            fullPath = `${rootPrefix}/${fullPath}`
        }

        const cdnUrl = storageConfig.value.cdnUrl.trim()

        if (cdnUrl) {
            const base = normalizeUrl(cdnUrl)
            return `${base}/${fullPath}`
        }

        // Same origin without VITE_BASE_URL, as in base-api.ts (code-issues item 59).
        const apiBase = normalizeUrl(import.meta.env.VITE_BASE_URL ?? '')
        return `${apiBase}${apiPath(`storage/${fullPath}`)}`
    }

    // Функция для определения режима PWA
    const checkPWAMode = () => {
        isPWAMode.value = isPwaMode()
        return isPWAMode.value
    }

    // Инициализируем проверку PWA режима
    checkPWAMode()

    // Отслеживаем изменения display-mode
    const standaloneMediaQuery = window.matchMedia('(display-mode: standalone)')
    const minimalUIMediaQuery = window.matchMedia('(display-mode: minimal-ui)')

    standaloneMediaQuery.addEventListener('change', checkPWAMode)
    minimalUIMediaQuery.addEventListener('change', checkPWAMode)

    window.addEventListener('resize', handleResize)

    // Push notifications initialization
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

    // Вспомогательная функция для конвертации VAPID ключа
    const urlBase64ToUint8Array = (base64String: string): Uint8Array => {
        const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
        const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')

        const rawData = window.atob(base64)
        const outputArray = new Uint8Array(rawData.length)

        for (let i = 0; i < rawData.length; ++i) {
            outputArray[i] = rawData.charCodeAt(i)
        }
        return outputArray
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

    // Проверка валидности VAPID ключа
    const isValidVapidKey = (key: string | null): key is string => {
        if (!key) return false
        if (key === 'YOUR_VAPID_PUBLIC_KEY_HERE') return false
        if (key.length < 80) return false // VAPID ключи обычно длиннее
        return true
    }

    // Определение типа устройства
    const getDeviceType = (): string => {
        const userAgent = navigator.userAgent.toLowerCase()
        if (/mobile|android|iphone|ipad|tablet/.test(userAgent)) {
            return 'mobile'
        }
        return 'desktop'
    }

    // Определение браузера и версии
    const getBrowserInfo = (): { name: string; version: string } => {
        const userAgent = navigator.userAgent
        const userAgentLower = userAgent.toLowerCase()

        let browserName = 'Unknown'
        let browserVersion = 'Unknown'

        if (userAgentLower.includes('chrome') && !userAgentLower.includes('edg')) {
            browserName = 'Chrome'
            const match = /Chrome\/(\d+\.\d+)/.exec(userAgent)
            browserVersion = match ? match[1] : 'Unknown'
        } else if (userAgentLower.includes('firefox')) {
            browserName = 'Firefox'
            const match = /Firefox\/(\d+\.\d+)/.exec(userAgent)
            browserVersion = match ? match[1] : 'Unknown'
        } else if (userAgentLower.includes('safari') && !userAgentLower.includes('chrome')) {
            browserName = 'Safari'
            const match = /Version\/(\d+\.\d+)/.exec(userAgent)
            browserVersion = match ? match[1] : 'Unknown'
        } else if (userAgentLower.includes('edg')) {
            browserName = 'Edge'
            const match = /Edg\/(\d+\.\d+)/.exec(userAgent)
            browserVersion = match ? match[1] : 'Unknown'
        }

        return { name: browserName, version: browserVersion }
    }

    // Определение операционной системы и версии
    const getOSInfo = (): { name: string; version: string } => {
        const userAgent = navigator.userAgent

        let osName = 'Unknown'
        let osVersion = 'Unknown'

        if (userAgent.includes('Windows NT')) {
            osName = 'Windows'
            const match = /Windows NT (\d+\.\d+)/.exec(userAgent)
            osVersion = match ? match[1] : 'Unknown'
        } else if (userAgent.includes('Mac OS X')) {
            osName = 'macOS'
            const match = /Mac OS X (\d+[._]\d+[._]?\d*)/.exec(userAgent)
            osVersion = match ? match[1].replace(/_/g, '.') : 'Unknown'
        } else if (userAgent.includes('Linux')) {
            osName = 'Linux'
            osVersion = 'Unknown'
        } else if (userAgent.includes('Android')) {
            osName = 'Android'
            const match = /Android (\d+\.\d+)/.exec(userAgent)
            osVersion = match ? match[1] : 'Unknown'
        } else if (userAgent.includes('iPhone') || userAgent.includes('iPad')) {
            osName = 'iOS'
            const match = /OS (\d+[._]\d+[._]?\d*)/.exec(userAgent)
            osVersion = match ? match[1].replace(/_/g, '.') : 'Unknown'
        }

        return { name: osName, version: osVersion }
    }

    // Отправка подписки на сервер
    const sendSubscriptionToServer = async (subscription: PushSubscription): Promise<void> => {
        try {
            const browserInfo = getBrowserInfo()
            const osInfo = getOSInfo()

            const subscriptionData = {
                endpoint: subscription.endpoint,
                p256dhKey: arrayBufferToBase64(subscription.getKey('p256dh')),
                authKey: arrayBufferToBase64(subscription.getKey('auth')),
                userAgent: navigator.userAgent,
                deviceType: getDeviceType(),
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

    // Вспомогательная функция для конвертации ArrayBuffer в Base64
    const arrayBufferToBase64 = (buffer: ArrayBuffer | null): string => {
        if (!buffer) return ''
        const bytes = new Uint8Array(buffer)
        let binary = ''
        for (let i = 0; i < bytes.byteLength; i++) {
            binary += String.fromCharCode(bytes[i])
        }
        return window.btoa(binary)
    }

    // Инициализация уведомлений при загрузке
    initNotifications()

    // Применение темы
    function applyTheme() {
        if (darkMode.value) {
            document.documentElement.classList.add('dark-theme')
            localStorage.setItem('theme', 'dark')
        } else {
            document.documentElement.classList.remove('dark-theme')
            localStorage.setItem('theme', 'light')
        }
        document.documentElement.setAttribute('data-theme', colorTheme.value)
        localStorage.setItem('colorTheme', colorTheme.value)
    }

    // Применение глобального размера шрифта
    function applyFontSize() {
        const clampedFontSize = Math.min(Math.max(fontSize.value, 14), 20)
        const scale = clampedFontSize / 16
        document.documentElement.style.setProperty('--app-font-size', `${clampedFontSize}px`)
        document.documentElement.style.fontSize = `${clampedFontSize}px`
        document.documentElement.style.setProperty('--app-font-scale', String(scale))

        // document.body is null while the <head> is still being parsed.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (document.body) {
            // Never scale the whole page; font size setting should only affect typography.
            document.body.style.zoom = ''
        }

        localStorage.setItem('fontSize', String(clampedFontSize))
    }

    // Вызываем сразу для инициализации темы
    applyTheme()
    applyFontSize()

    function setDarkMode(value: boolean) {
        darkMode.value = value
        applyTheme()
    }

    function setColorTheme(value: string) {
        colorTheme.value = value
        applyTheme()
    }

    function setFontSize(value: number) {
        fontSize.value = value
        applyFontSize()
    }

    // Отслеживаем изменения темы
    watch(darkMode, applyTheme)
    watch(colorTheme, applyTheme)
    watch(fontSize, applyFontSize)

    return {
        darkMode,
        setDarkMode,
        colorTheme,
        setColorTheme,
        fontSize,
        setFontSize,
        windowWidth,
        isMobile,
        isPWAMode,
        checkPWAMode,
        // Push notifications
        notificationPermission,
        pushSubscription,
        isSubscribedToPush,
        pushSubscriptionId,
        storageConfig,
        setStorageConfig,
        getStorageFileUrl,
        requestNotificationPermission,
        ensureNotificationPermission,
        subscribeToPush,
        unsubscribeFromPush,
        ensurePushSubscriptionsLoaded,
        resetPushSubscriptionState,
    }
})
