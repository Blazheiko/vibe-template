<script setup lang="ts">
// Главный компонент приложения
import { onMounted, ref, computed, onBeforeUnmount } from 'vue'
import { safeRedirectTarget } from '@/utils/safe-redirect'
import { useI18n } from 'vue-i18n'
import { useStateStore } from '@/stores/state'
import { useUserStore } from '@/stores/user'
import { useRouter, useRoute } from 'vue-router'
import { mainApi } from '@/utils/api'
import { setCurrentUserIdProvider } from '@/utils/base-api'
import { useEventBus } from '@/utils/event-bus'
import AppHeader from '@/components/AppHeader.vue'
import UpdateNotification from '@/components/UpdateNotification.vue'
import ToastContainer from '@/components/ToastContainer.vue'
import AiDisclosureBanner from '@/components/AiDisclosureBanner.vue'
import { useWebSocketConnection } from '@/composables/useWebSocketConnection'
import { useSessionLifecycle } from '@/composables/useSessionLifecycle'
import { hasResponseError, isUnauthorizedError } from '@/utils/response-normalizer'

const { t } = useI18n()
const router = useRouter()
const route = useRoute()
const userStore = useUserStore()
// CSRF recovery checks a refreshed session against the user the UI shows.
setCurrentUserIdProvider(() => userStore.user?.id ?? null)
const isLoading = ref(true)

const stateStore = useStateStore()
const eventBus = useEventBus()
const { websocketClose, websocketOpen } = useWebSocketConnection()
const { redirectToLogin } = useSessionLifecycle()

const hasUpdate = ref(false)

const handleUpdateAvailable = () => {
    hasUpdate.value = true
}

const refreshApp = () => {
    window.location.reload()
}

const dismissUpdate = () => {
    hasUpdate.value = false
}

// Объявляем функции заранее
const onReauthorize = async () => {
    console.error('onReauthorize')
    await redirectToLogin()
}

const destroyWebsocketBase = () => {
    console.log('destroyWebsocketBase')
    websocketClose()
}

// Пропсы для глобального хедера из meta маршрута
const headerTitle = computed(() => route.meta.title ?? '')
const headerShowBack = computed(() => Boolean(route.meta.showBack))

const SCROLLABLE_ROUTES = new Set(['/privacy-policy', '/terms', '/cookies', '/ai-policy'])
const isScrollablePage = computed(() => SCROLLABLE_ROUTES.has(route.path))

// Обработчик изменения размера окна
// const handleResize = () => {
//     windowWidth.value = window.innerWidth
// }

// mitt ignores handler results: start the async handlers without awaiting them.
const onInitAppEvent = () => {
    void initializeApp()
}
const onUnauthorizedEvent = () => {
    void onReauthorize()
}

// Определяем тему при загрузке приложения
onMounted(async () => {
    // Добавляем слушатель изменения размера окна
    // window.addEventListener('resize', handleResize)

    // Слушаем изменения предпочтений системы
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
        stateStore.setDarkMode(e.matches)
        // if (localStorage.getItem('theme') === null) {
        //     stateStore.setDarkMode(e.matches)
        // }
    })

    // Block the router guard until initializeApp completes
    userStore.resetReady()

    await initializeApp()
    isLoading.value = false
    eventBus.on('init_app', onInitAppEvent)
    eventBus.on('unauthorized', onUnauthorizedEvent)
    eventBus.on('destroy_websocket_base', destroyWebsocketBase)
    eventBus.on('update_available', handleUpdateAvailable)
})

// Удаляем слушатель при размонтировании компонента
onBeforeUnmount(() => {
    // window.removeEventListener('resize', handleResize)
    eventBus.off('init_app', onInitAppEvent)
    eventBus.off('unauthorized', onUnauthorizedEvent)
    eventBus.off('update_available', handleUpdateAvailable)
    eventBus.off('destroy_websocket_base', destroyWebsocketBase)
})

// interface UserOnlineData {
//     userId: number
//     isOnline: boolean
// }

// interface NewMessageData {
//     contactId: number
//     content: string
// }

// Обработка broadcast событий теперь происходит в useBroadcastHandler composable

const PUBLIC_PATHS = new Set([
    '/',
    '/login',
    '/register',
    '/verify-email',
    '/reset-password',
    '/about',
    '/privacy-policy',
    '/terms',
    '/cookies',
    '/ai-policy',
])

const initializeApp = async () => {
    try {
        const { data, error } = await mainApi.init()
        const url = window.location.href
        const routePath = new URL(url).pathname
        const isPublicPath = PUBLIC_PATHS.has(routePath)

        if (error) {
            console.error('Error in initialization:', error)
            if (isUnauthorizedError(data, error.transportCode) && !isPublicPath) {
                await redirectToLogin()
            }
            return null
        } else if (
            data &&
            !hasResponseError(data) &&
            data.status === 'ok' &&
            data.user &&
            data.wsUrl &&
            data.wsToken
        ) {
            userStore.setUser(data.user)
            stateStore.setStorageConfig({
                cdnUrl: data.storage?.cdnUrl ?? '',
                s3Prefix: data.storage?.s3Prefix ?? '',
                s3StaticDataPrefix: data.storage?.s3StaticDataPrefix ?? '',
                s3DynamicDataPrefix: data.storage?.s3DynamicDataPrefix ?? '',
            })
            // const routeName = route.name

            // console.log(`Data in initialization: route - ${String(routeName)}, path - ${routePath}`)

            if (routePath === '/' || routePath === '/login' || routePath === '/register') {
                // Only a path inside the application: the link that carries it is not trusted.
                const intended = safeRedirectTarget(route.query.redirect)
                if (intended !== null) {
                    void router.push(intended)
                } else {
                    void router.push({ name: 'UserAccount' })
                }
            }

            websocketOpen(data.wsUrl, data.wsToken)
        }
    } catch (error) {
        console.error('Error in initialization:', error)
    } finally {
        userStore.markReady()
    }
}
</script>

<template>
    <div :class="['app-container', { 'app-container--scrollable': isScrollablePage }]">
        <div v-if="isLoading" class="loader-container">
            <div class="loader"></div>
            <p>{{ t('app.loading') }}</p>
        </div>
        <template v-else>
            <AppHeader
                v-if="userStore.user && !route.meta.hideHeader"
                :title="headerTitle"
                :show-back="headerShowBack"
            />
            <router-view />
        </template>

        <UpdateNotification v-if="hasUpdate" @refresh="refreshApp" @dismiss="dismissUpdate" />

        <!-- Универсальные toast-уведомления -->
        <ToastContainer />

        <!-- AI disclosure banner (shown once per user until dismissed) -->
        <AiDisclosureBanner v-if="userStore.user" :user-id="userStore.user.id" />
    </div>
</template>

<style>
:root {
    --box-shadow: var(--shadow-sm);
    --border-radius: 12px;
    --content-max-width: 800px;
    --header-height: 56px;
    --app-font-size: 16px;
    --app-font-scale: 1;
    /* Indicator colors */
    --glass-bg: rgba(255, 255, 255, 0.8);
    --glass-border: rgba(255, 255, 255, 0.3);
    --app-header-bg: var(--accent-hover);
}

:root.dark-theme {
    --glass-bg: rgba(30, 41, 59, 0.8);
    --glass-border: rgba(255, 255, 255, 0.1);
}

* {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
}

html,
body {
    width: 100%;
    height: 100dvh;
    overflow: hidden;
    margin: 0;
    padding: 0;
    overscroll-behavior: none;
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
}

html {
    font-size: var(--app-font-size);
}

body {
    font-family:
        'Inter',
        -apple-system,
        BlinkMacSystemFont,
        'Segoe UI',
        Roboto,
        Helvetica,
        Arial,
        sans-serif,
        'Apple Color Emoji',
        'Segoe UI Emoji',
        'Segoe UI Symbol';
    background-color: var(--background-color);
    color: var(--text-color);
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    -webkit-text-size-adjust: 100%;
    text-size-adjust: 100%;
    font-size: 1rem;
}

#app {
    height: 100dvh;
    width: 100%;
    position: relative;
    display: flex;
    flex-direction: column;
    overflow: hidden;
}

.app-container {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
}

.app-container--scrollable {
    overflow-y: auto;
    overflow-x: hidden;
}

button {
    font-family: inherit;
}

a {
    color: var(--primary-color);
    text-decoration: none;
}

h1,
h2,
h3,
h4,
h5,
h6 {
    font-weight: 600;
    line-height: 1.3;
}

img,
svg {
    max-width: 100%;
    height: auto;
}

textarea,
input {
    font-family: inherit;
    font-size: inherit;
}

/* Глобальные утилитарные классы */
.container {
    width: 100%;
    max-width: var(--content-max-width);
    margin: 0 auto;
    padding: 0 20px;
}

@media (max-width: 768px) {
    :root {
        --content-max-width: 100%;
        --header-height: 48px;
    }

    body {
        font-size: 0.9375rem;
    }

    .container {
        padding: 0 16px;
    }

    h1 {
        font-size: calc(24px * var(--app-font-scale, 1));
    }

    h2 {
        font-size: calc(20px * var(--app-font-scale, 1));
    }

    h3 {
        font-size: calc(18px * var(--app-font-scale, 1));
    }
}

.loader-container {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    background-color: var(--background-color);
    z-index: 9999;
}

.loader {
    width: 48px;
    height: 48px;
    border: 5px solid var(--primary-color);
    border-bottom-color: transparent;
    border-radius: 50%;
    display: inline-block;
    box-sizing: border-box;
    animation: rotation 1s linear infinite;
    margin-bottom: 16px;
}

.loader-container p {
    color: var(--text-color);
    font-size: calc(18px * var(--app-font-scale, 1));
    font-weight: 500;
}

@keyframes rotation {
    0% {
        transform: rotate(0deg);
    }
    100% {
        transform: rotate(360deg);
    }
}
</style>
