<script setup lang="ts">
import { ref, onMounted, defineComponent, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import AuthModals from '../components/AuthModals.vue'
import { useStateStore } from '@/stores/state'
import { useRouter, useRoute } from 'vue-router'
import { useEventBus } from '@/utils/event-bus'

defineComponent({
    name: 'LoginView',
})

const { t } = useI18n({ useScope: 'global' })
const stateStore = useStateStore()
const router = useRouter()
const route = useRoute()
const eventBus = useEventBus()

const isLoginModalVisible = ref(false)
const oauthError = ref('')
const oauthNotice = ref('')

const OAUTH_ERROR_REASONS = {
    oauth_link_revoked: 'login.socialLoginLinkRevoked',
    email_changed: 'login.socialLoginEmailChanged',
    oauth_already_linked: 'login.socialLoginAlreadyLinked',
    too_many_attempts: 'login.socialLoginTooManyAttempts',
} as const
const isRegisterModalVisible = ref(false)
const logoText = ref('VIBE')
const typingComplete = ref(false)
// const showAuthModals = ref(false)
const showLoginModal = () => {
    isLoginModalVisible.value = true
    isRegisterModalVisible.value = false
    if (route.name !== 'Login') {
        void router.replace({ name: 'Login' })
    }
}

const showRegisterModal = () => {
    isLoginModalVisible.value = false
    isRegisterModalVisible.value = true
    if (route.name !== 'Register') {
        void router.replace({ name: 'Register' })
    }
}

const closeAuthModals = () => {
    isLoginModalVisible.value = false
    isRegisterModalVisible.value = false
    if (route.name === 'Login' || route.name === 'Register') {
        void router.replace({ name: 'Home' })
    }
}

// Автоматический показ модального окна в PWA режиме или по маршруту
const checkAndShowModal = () => {
    const authModal = route.meta.authModal as string | undefined
    if (authModal === 'login') {
        isLoginModalVisible.value = true
        isRegisterModalVisible.value = false
    } else if (authModal === 'register') {
        isLoginModalVisible.value = false
        isRegisterModalVisible.value = true
    } else if (stateStore.isPWAMode) {
        isLoginModalVisible.value = true
    }
}

// Отслеживаем изменения PWA режима
watch(
    () => stateStore.isPWAMode,
    () => {
        checkAndShowModal()
    },
    { immediate: true },
)

// Отслеживаем изменения маршрута
watch(
    () => route.meta.authModal,
    () => {
        checkAndShowModal()
    },
)

// Эффект печатающего текста для лого
onMounted(() => {
    // Handle OAuth success redirect
    const queryOauth = route.query.oauth
    const queryError = route.query.error

    if (queryOauth === 'success') {
        // Clear the query params
        void router.replace({ query: {} })
        // Trigger app initialization (fetches user via mainApi.init)
        eventBus.emit('init_app')
        void router.push({ name: 'UserAccount' })
        return
    }

    if (queryOauth === 'link_pending') {
        // feat-097: the provider's email belongs to an existing account. Nobody is signed in
        // yet: the link mailed to that address finishes the sign-in, in this browser only.
        oauthNotice.value = t('login.socialLoginLinkPending')
        void router.replace({ query: {} })
    }

    if (queryError === 'oauth_failed') {
        // The backend adds a reason for the refusals the user can act on (feat-097).
        const reason = route.query.reason
        oauthError.value =
            typeof reason === 'string' && reason in OAUTH_ERROR_REASONS
                ? t(OAUTH_ERROR_REASONS[reason as keyof typeof OAUTH_ERROR_REASONS])
                : t('login.socialLoginFailed')
        void router.replace({ query: {} })
    }

    const text = 'VIBE'
    let i = 0
    logoText.value = ' '

    const typeWriter = () => {
        if (i < text.length) {
            logoText.value += text.charAt(i)
            i++
            setTimeout(typeWriter, 150)
        } else {
            typingComplete.value = true
        }
    }

    // Проверяем PWA и маршрут сразу, не дожидаясь анимации
    checkAndShowModal()

    // Запускаем анимацию печати с небольшой задержкой
    setTimeout(typeWriter, 1000)
})
</script>

<template>
    <div class="login-page">
        <!-- Desktop version -->
        <div v-if="!stateStore.isMobile" class="auth-container auth-container-desktop">
            <div class="logo" :class="{ 'typing-complete': typingComplete }">
                {{ logoText }}<span class="cursor"></span>
            </div>

            <div class="welcome-message">
                <h1>{{ t('login.heroTitle') }}</h1>
                <p>{{ t('login.heroSubtitle') }}</p>
            </div>

            <div class="features">
                <div class="feature-item">
                    <div class="feature-icon">
                        <svg
                            xmlns="http://www.w3.org/2000/svg"
                            viewBox="0 0 24 24"
                            width="24"
                            height="24"
                        >
                            <path
                                d="M12.87 15.07l-2.54-2.51.03-.03A17.52 17.52 0 0 0 14.07 6H17V4h-7V2H8v2H1v2h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7l1.62-4.33L19.12 17h-3.24z"
                                fill="currentColor"
                            />
                        </svg>
                    </div>
                    <div class="feature-text">
                        <h3>{{ t('login.featureSupportTitle') }}</h3>
                        <p>{{ t('login.featureSupportDesc') }}</p>
                    </div>
                </div>

                <div class="feature-item">
                    <div class="feature-icon">
                        <svg
                            xmlns="http://www.w3.org/2000/svg"
                            viewBox="0 0 24 24"
                            width="24"
                            height="24"
                        >
                            <path
                                d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-7 9h-2V5h2v6zm0 4h-2v-2h2v2z"
                                fill="currentColor"
                            />
                        </svg>
                    </div>
                    <div class="feature-text">
                        <h3>{{ t('login.featureAccountTitle') }}</h3>
                        <p>{{ t('login.featureAccountDesc') }}</p>
                    </div>
                </div>

                <div class="feature-item">
                    <div class="feature-icon">
                        <svg
                            xmlns="http://www.w3.org/2000/svg"
                            viewBox="0 0 24 24"
                            width="24"
                            height="24"
                        >
                            <path
                                d="M12 1a9 9 0 0 1 9 9c0 4.17-2.84 7.67-6.7 8.67L12 21l-2.3-2.33C5.84 17.67 3 14.17 3 10a9 9 0 0 1 9-9zm0 2a7 7 0 0 0-7 7c0 3.31 2.24 6.1 5.37 6.93L12 18.53l1.63-1.6C16.76 16.1 19 13.31 19 10a7 7 0 0 0-7-7zm1 3v4h3l-4 5v-4H9l4-5z"
                                fill="currentColor"
                            />
                        </svg>
                    </div>
                    <div class="feature-text">
                        <h3>{{ t('login.featureVoiceTitle') }}</h3>
                        <p>{{ t('login.featureVoiceDesc') }}</p>
                    </div>
                </div>
            </div>

            <div v-if="oauthError" class="oauth-error" role="alert">{{ oauthError }}</div>
            <div v-if="oauthNotice" class="oauth-notice" role="status">{{ oauthNotice }}</div>

            <div class="auth-buttons">
                <button class="auth-button" @click="showLoginModal">{{ t('login.signIn') }}</button>
                <button class="auth-button register" @click="showRegisterModal">
                    {{ t('login.createAccount') }}
                </button>
            </div>

            <div class="manifesto-link-container">
                <router-link to="/about" class="manifesto-link">{{ t('login.about') }}</router-link>
            </div>
        </div>

        <!-- Mobile version - minimalistic -->
        <div v-else class="auth-container auth-container-mobile">
            <div class="welcome-message">
                <h1>{{ t('login.mobileTitle') }}</h1>
                <p>{{ t('login.mobileSubtitle') }}</p>
            </div>
            <div v-if="oauthError" class="oauth-error" role="alert">{{ oauthError }}</div>
            <div v-if="oauthNotice" class="oauth-notice" role="status">{{ oauthNotice }}</div>
            <div class="auth-buttons">
                <button class="auth-button" @click="showLoginModal">{{ t('login.signIn') }}</button>
                <button class="auth-button register" @click="showRegisterModal">
                    {{ t('login.createAccount') }}
                </button>
            </div>

            <div class="manifesto-link-container">
                <router-link to="/about" class="manifesto-link">{{ t('login.about') }}</router-link>
            </div>
        </div>

        <AuthModals
            :show-login="isLoginModalVisible"
            :show-register="isRegisterModalVisible"
            @close="closeAuthModals"
            @show-login="showLoginModal"
            @show-register="showRegisterModal"
            v-if="isLoginModalVisible || isRegisterModalVisible"
        />
    </div>
</template>

<style scoped>
.login-page {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    min-height: 100dvh;
    width: 100%;
    background: linear-gradient(135deg, #f8f9fa 0%, #e9ecef 100%);
    padding: 20px;
    padding-bottom: env(safe-area-inset-bottom, 20px);
}

.dark-theme .login-page {
    background: linear-gradient(135deg, #121212 0%, #1a1a1a 100%);
}

.auth-container {
    display: flex;
    flex-direction: column;
    align-items: center;
    width: 100%;
    background-color: white;
    border-radius: 20px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.05);
}

.auth-container-desktop {
    max-width: 600px;
    padding: 40px;
}

.auth-container-mobile {
    max-width: 100%;
    padding: 24px 20px;
    border-radius: 16px;
    box-shadow: 0 5px 15px rgba(0, 0, 0, 0.05);
}

.dark-theme .auth-container {
    background-color: #1e1e1e;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3);
}

.dark-theme .auth-container-mobile {
    box-shadow: 0 5px 15px rgba(0, 0, 0, 0.3);
}

.logo {
    font-size: calc(42px * var(--app-font-scale, 1));
    font-weight: 800;
    color: var(--primary-color);
    margin-bottom: 30px;
    letter-spacing: -1px;
    position: relative;
    display: inline-block;
}

.cursor {
    position: absolute;
    right: -12px;
    top: 5%;
    height: 90%;
    width: 3px;
    background-color: var(--primary-color);
    animation: blink 1s infinite;
}

.typing-complete .cursor {
    animation: fadeOut 0.5s forwards;
}

@keyframes blink {
    0%,
    100% {
        opacity: 0;
    }
    50% {
        opacity: 1;
    }
}

@keyframes fadeOut {
    from {
        opacity: 1;
    }
    to {
        opacity: 0;
        visibility: hidden;
    }
}

.welcome-message {
    text-align: center;
    margin-bottom: 30px;
    width: 100%;
}

.welcome-message h1 {
    font-size: calc(32px * var(--app-font-scale, 1));
    font-weight: 700;
    margin-bottom: 10px;
    color: var(--text-color);
}

.dark-theme .welcome-message h1 {
    color: #e0e0e0;
}

.welcome-message p {
    font-size: calc(16px * var(--app-font-scale, 1));
    color: #6c757d;
    margin: 0;
}

.dark-theme .welcome-message p {
    color: #adb5bd;
}

.features {
    width: 100%;
    margin-bottom: 30px;
}

.feature-item {
    display: flex;
    align-items: flex-start;
    gap: 16px;
    margin-bottom: 24px;
    padding: 16px;
    background-color: #f8f9fa;
    border-radius: 12px;
    transition: all 0.2s ease;
}

.dark-theme .feature-item {
    background-color: #2a2a2a;
}

.feature-icon {
    width: 40px;
    height: 40px;
    background-color: var(--primary-color);
    border-radius: 10px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: white;
    flex-shrink: 0;
}

.dark-theme .feature-icon {
    background-color: #0d47a1;
}

.feature-text h3 {
    font-size: calc(18px * var(--app-font-scale, 1));
    font-weight: 600;
    margin: 0 0 8px;
    color: var(--text-color);
}

.dark-theme .feature-text h3 {
    color: #e0e0e0;
}

.feature-text p {
    font-size: calc(14px * var(--app-font-scale, 1));
    color: #6c757d;
    margin: 0;
    line-height: 1.5;
}

.dark-theme .feature-text p {
    color: #adb5bd;
}

.auth-buttons {
    display: flex;
    gap: 16px;
    width: 100%;
    max-width: 400px;
}

.auth-container-desktop .auth-buttons {
    margin-top: 32px;
}

.auth-container-mobile .auth-buttons {
    margin-top: 0;
    flex-direction: column;
}

.auth-button {
    flex: 1;
    padding: 12px 24px;
    border: none;
    border-radius: 12px;
    font-size: calc(16px * var(--app-font-scale, 1));
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s ease;
    background-color: var(--primary-color);
    color: white;
}

.dark-theme .auth-button {
    background-color: #0d47a1;
}

.auth-button:hover {
    transform: translateY(-2px);
    box-shadow: 0 4px 12px rgba(26, 115, 232, 0.3);
}

.dark-theme .auth-button:hover {
    box-shadow: 0 4px 12px rgba(13, 71, 161, 0.3);
}

.auth-button.register {
    background-color: white;
    color: var(--primary-color);
    border: 2px solid var(--primary-color);
}

.dark-theme .auth-button.register {
    background-color: #2a2a2a;
    color: #e0e0e0;
    border-color: #0d47a1;
}

.auth-button.register:active {
    background-color: rgba(26, 115, 232, 0.1);
}

.manifesto-link-container {
    text-align: center;
}

.auth-container-desktop .manifesto-link-container {
    margin-top: 24px;
}

.auth-container-mobile .manifesto-link-container {
    margin-top: 20px;
}

.manifesto-link {
    color: var(--primary-color);
    text-decoration: none;
    font-weight: 500;
    margin-top: 24px;
    transition: all 0.2s ease;
}

.dark-theme .manifesto-link {
    color: #64b5f6;
}

.manifesto-link:hover {
    text-decoration: underline;
    opacity: 0.9;
}

.pwa-login-hint {
    text-align: center;
    margin: 32px 0;
    padding: 20px;
    background: linear-gradient(135deg, var(--primary-color), var(--accent-color));
    border-radius: 12px;
    color: white;
    animation: pulse 2s infinite;
}

.dark-theme .pwa-login-hint {
    background: linear-gradient(135deg, #0d47a1, #1565c0);
}

.pwa-login-hint p {
    margin: 0;
    font-size: calc(16px * var(--app-font-scale, 1));
    font-weight: 600;
}

.pwa-login-hint .hint-text {
    font-size: calc(14px * var(--app-font-scale, 1));
    font-weight: 400;
    opacity: 0.9;
    margin-top: 8px;
}

@keyframes pulse {
    0%,
    100% {
        opacity: 1;
        transform: scale(1);
    }
    50% {
        opacity: 0.8;
        transform: scale(1.02);
    }
}

.oauth-error,
.oauth-notice {
    width: 100%;
    max-width: 400px;
    padding: 12px 16px;
    background-color: rgba(220, 53, 69, 0.1);
    color: #dc3545;
    border-radius: 10px;
    font-size: calc(14px * var(--app-font-scale, 1));
    font-weight: 500;
    text-align: center;
    margin-bottom: 16px;
}

.dark-theme .oauth-error {
    background-color: rgba(220, 53, 69, 0.2);
    color: #ff6b6b;
}

.oauth-notice {
    background-color: color-mix(in srgb, var(--primary-color) 12%, transparent);
    color: var(--text-primary);
}

@media (max-width: 768px) {
    .auth-container-mobile .auth-button {
        width: 100%;
        padding: 14px 0;
        font-size: calc(16px * var(--app-font-scale, 1));
    }
}
</style>
