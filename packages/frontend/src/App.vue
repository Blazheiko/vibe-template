<script setup lang="ts">
// Главный компонент приложения
import { onMounted, ref, computed, onBeforeUnmount, watch } from 'vue'
import { takePostSignInTarget } from '@/utils/post-sign-in-target'
import { normalizeRoutePath } from '@/utils/route-path'
import { safeRedirectTarget } from '@/utils/safe-redirect'
import { useI18n } from 'vue-i18n'
import { usePushStore } from '@/stores/push'
import { useStateStore } from '@/stores/state'
import { useUserStore } from '@/stores/user'
import { useRouter, useRoute } from 'vue-router'
import { mainApi } from '@/utils/api'
import { setCurrentUserIdProvider } from '@/utils/base-api'
import { useEventBus } from '@/utils/event-bus'
import AppHeader from '@/components/AppHeader.vue'
import ReauthDialog from '@/components/account/ReauthDialog.vue'
import UpdateNotification from '@/components/UpdateNotification.vue'
import ChunkLoadNotice from '@/components/ChunkLoadNotice.vue'
import AiDisclosureBanner from '@/components/AiDisclosureBanner.vue'
import { useWebSocketConnection } from '@/composables/useWebSocketConnection'
import { useSessionLifecycle } from '@/composables/useSessionLifecycle'
import { useProfileSync } from '@/composables/useProfileSave'
import { useAccessSync } from '@/composables/useAccessSync'
import { applyLocalePreference } from '@/composables/useLocale'
import { hasResponseError, isUnauthorizedError } from '@/utils/response-normalizer'

const { t } = useI18n()
const router = useRouter()
const route = useRoute()
const userStore = useUserStore()
const pushStore = usePushStore()
// CSRF recovery checks a refreshed session against the user the UI shows.
setCurrentUserIdProvider(() => userStore.user?.id ?? null)
const isLoading = ref(true)

const stateStore = useStateStore()
const eventBus = useEventBus()
const { websocketOpen } = useWebSocketConnection()
const { redirectToLogin } = useSessionLifecycle()

// feat-232: the preferences of whoever is signed in (the device's own otherwise), and the
// interface language they choose: profile, then browser, then English (Р7).
useProfileSync()
// feat-240 (Р8): the role in this tab follows the server; a page it may no longer see is left.
useAccessSync(router)
watch(
    () => stateStore.locale,
    (locale) => {
        void applyLocalePreference(locale)
    },
    { immediate: true },
)

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

// feat-245 (Р15): an action needs a new sign-in; come back to `returnTo` afterwards.
const onSignInAgain = (returnTo: string): void => {
    void redirectToLogin(returnTo)
}

// Объявляем функции заранее
const onReauthorize = async () => {
    console.error('onReauthorize')
    await redirectToLogin()
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

    // Р13 (feat-232): the store follows the system theme only while no theme is chosen.
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
        stateStore.setSystemDark(e.matches)
    })

    // Block the router guard until initializeApp completes
    userStore.resetReady()

    await initializeApp()
    isLoading.value = false
    eventBus.on('init_app', onInitAppEvent)
    eventBus.on('unauthorized', onUnauthorizedEvent)
    eventBus.on('sign_in_again', onSignInAgain)
    eventBus.on('update_available', handleUpdateAvailable)
})

// Удаляем слушатель при размонтировании компонента
onBeforeUnmount(() => {
    // window.removeEventListener('resize', handleResize)
    eventBus.off('init_app', onInitAppEvent)
    eventBus.off('unauthorized', onUnauthorizedEvent)
    eventBus.off('sign_in_again', onSignInAgain)
    eventBus.off('update_available', handleUpdateAvailable)
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
    '/oauth/link/confirm',
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
        // feat-211: by the normalized path. `/Reset-Password/` is the public reset page too;
        // compared by the exact spelling it was taken for a private one and sent to /login.
        const isPublicPath = PUBLIC_PATHS.has(normalizeRoutePath(routePath))

        if (error) {
            console.error('Error in initialization:', error)
            if (isUnauthorizedError(data, error.transportCode)) {
                // The session is known to be anonymous: the device's own look (feat-232).
                userStore.markAnonymous()
                if (!isPublicPath) await redirectToLogin()
            }
            return null
        } else if (data && !hasResponseError(data) && data.status === 'ok' && data.user) {
            userStore.setInitUser(data.user)
            // feat-245 (Р8): a recovery session has no WebSocket and only the recovery wizard.
            userStore.setRecovery(data.recovery ?? null)
            if (data.recovery !== undefined) {
                if (routePath !== '/account') void router.push({ name: 'UserAccount' })
                return null
            }
            if (!data.wsUrl || !data.wsToken) return null
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
                // From the link, or kept in the tab across an OAuth round trip (feat-154).
                const intended = safeRedirectTarget(route.query.redirect) ?? takePostSignInTarget()
                if (intended !== null) {
                    void router.push(intended)
                } else {
                    void router.push({ name: 'UserAccount' })
                }
            }

            websocketOpen(data.wsUrl, data.wsToken)
            // A subscription another account left in this browser is removed here, not only
            // when the account page is opened (feat-148).
            void pushStore.ensurePushSubscriptionsLoaded()
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
            <!-- feat-245 (Р15): the one step-up dialog of every sensitive action. -->
            <ReauthDialog />
        </template>

        <UpdateNotification v-if="hasUpdate" @refresh="refreshApp" @dismiss="dismissUpdate" />
        <ChunkLoadNotice />

        <!-- Универсальные toast-уведомления -->

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
