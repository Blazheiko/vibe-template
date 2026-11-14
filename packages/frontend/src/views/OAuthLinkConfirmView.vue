<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { authApi } from '@/utils/api'
import { clearUrlToken, readUrlToken } from '@/utils/one-time-url-token'
import { getErrorReason } from '@/utils/response-normalizer'
import { useUserStore } from '@/stores/user'
import { useEventBus } from '@/utils/event-bus'

defineOptions({
    name: 'OAuthLinkConfirmView',
})

// feat-097: the link mailed when an OAuth sign-in matched an existing account. It links the
// provider and signs in, but only in the browser session that started that sign-in.

const route = useRoute()
const router = useRouter()
const { t } = useI18n()
const userStore = useUserStore()
const eventBus = useEventBus()

const status = ref<'loading' | 'success' | 'error'>('loading')
const message = ref('')

// feat-205: the token of the mailed link is taken out of the address before this page is
// shown and kept for it; the query is only what a caller that bypassed the router left.
const token = computed(() => {
    const kept = readUrlToken(route.path)
    if (kept !== '') return kept
    const rawToken = route.query.token
    return typeof rawToken === 'string' ? rawToken.trim() : ''
})

const ERROR_MESSAGES: Record<string, () => string> = {
    oauth_link_wrong_session: () => t('oauthLink.wrongSession'),
    used_token: () => t('oauthLink.used'),
    expired_token: () => t('oauthLink.expired'),
    invalid_token: () => t('oauthLink.invalid'),
    email_changed: () => t('oauthLink.emailChanged'),
    oauth_already_linked: () => t('oauthLink.alreadyLinked'),
}

function openAccount(): void {
    // The session now belongs to the linked account: the app reads it again (user, CSRF
    // token, WebSocket) and the account page waits for that before its auth check.
    userStore.resetReady()
    eventBus.emit('init_app')
    void router.replace({ name: 'UserAccount' })
}

async function confirmLink(): Promise<void> {
    if (token.value === '') {
        status.value = 'error'
        message.value = t('oauthLink.invalid')
        return
    }

    const { data, error } = await authApi.confirmOAuthLink({ token: token.value })
    if (error) {
        const reason = getErrorReason(data)
        const known = reason === undefined ? undefined : ERROR_MESSAGES[reason]
        status.value = 'error'
        message.value =
            known?.() ??
            (error.transportCode === 0 || error.transportCode >= 500
                ? t('oauthLink.failed')
                : error.message || t('oauthLink.failed'))
        return
    }

    if (data?.status !== 'success') {
        status.value = 'error'
        message.value = t('oauthLink.failed')
        return
    }

    // The link is spent: nothing of it stays in the browser.
    clearUrlToken(route.path)
    status.value = 'success'
    message.value = t('oauthLink.success')
    openAccount()
}

function goToLogin(): void {
    void router.push({ name: 'Login' })
}

onMounted(() => {
    void confirmLink()
})
</script>

<template>
    <div class="oauth-link-page">
        <div class="oauth-link-card">
            <p v-if="status === 'loading'" class="oauth-link-message" role="status">
                {{ t('oauthLink.loading') }}
            </p>

            <template v-else-if="status === 'success'">
                <h1>{{ t('oauthLink.successTitle') }}</h1>
                <p class="oauth-link-message" role="status">{{ message }}</p>
                <div class="oauth-link-actions">
                    <button class="oauth-link-primary" @click="openAccount">
                        {{ t('oauthLink.openAccount') }}
                    </button>
                </div>
            </template>

            <template v-else>
                <h1>{{ t('oauthLink.errorTitle') }}</h1>
                <p class="oauth-link-message" role="alert">{{ message }}</p>
                <div class="oauth-link-actions">
                    <button class="oauth-link-primary" @click="goToLogin">
                        {{ t('oauthLink.goToLogin') }}
                    </button>
                </div>
            </template>
        </div>
    </div>
</template>

<style scoped>
.oauth-link-page {
    min-height: 100dvh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background:
        radial-gradient(
            circle at top,
            color-mix(in srgb, var(--accent-color) 12%, transparent),
            transparent 42%
        ),
        linear-gradient(180deg, var(--bg-primary), var(--surface-color));
}

.oauth-link-card {
    width: min(100%, 520px);
    padding: 32px;
    border-radius: 20px;
    background: var(--surface-color);
    box-shadow: var(--shadow-md);
    text-align: center;
}

.oauth-link-card h1 {
    margin: 0 0 12px;
    color: var(--text-primary);
    font-size: 2rem;
}

.oauth-link-message {
    margin: 0;
    color: var(--text-secondary);
    line-height: 1.6;
}

.oauth-link-actions {
    margin-top: 24px;
    display: flex;
    justify-content: center;
}

.oauth-link-primary {
    border: none;
    border-radius: 12px;
    background: var(--primary-color);
    color: #fff;
    padding: 12px 18px;
    font-weight: 600;
    cursor: pointer;
}

.oauth-link-primary:hover {
    background: var(--primary-hover);
}
</style>
