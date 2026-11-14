<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { PASSWORD_MAX_LENGTH } from 'shared/limits'
import { authApi, mainApi } from '@/utils/api'
import { clearUrlToken, readUrlToken } from '@/utils/one-time-url-token'
import { getErrorReason } from '@/utils/response-normalizer'
import { useUserStore } from '@/stores/user'

defineOptions({
    name: 'VerifyEmailView',
})

const route = useRoute()
const router = useRouter()
const { t } = useI18n()
const userStore = useUserStore()

// `password`: a registration link opened without a session of its account (feat-097) needs
// the account's password; the link stays usable until the right one is entered.
const status = ref<'loading' | 'password' | 'success' | 'error'>('loading')
const message = ref('')
const password = ref('')
const passwordError = ref('')
const isSubmitting = ref(false)

// feat-205: the token of the mailed link is taken out of the address before this page is
// shown and kept for it; the query is only what a caller that bypassed the router left.
const token = computed(() => {
    const kept = readUrlToken(route.path)
    if (kept !== '') return kept
    const rawToken = route.query.token
    return typeof rawToken === 'string' ? rawToken.trim() : ''
})

// The refusals the user can act on; any other error shows the server's message.
const ERROR_MESSAGES: Record<string, () => string> = {
    email_link_wrong_session: () => t('emailVerification.wrongSession'),
    session_revoked: () => t('emailVerification.sessionRevoked'),
}

async function verifyEmail(withPassword?: string): Promise<void> {
    if (token.value === '') {
        status.value = 'error'
        message.value = t('emailVerification.invalid')
        return
    }

    message.value = ''
    passwordError.value = ''
    isSubmitting.value = true
    const { data, error } = await authApi
        .verifyEmail(
            withPassword === undefined
                ? { token: token.value }
                : { token: token.value, password: withPassword },
        )
        .finally(() => {
            isSubmitting.value = false
        })

    if (error) {
        const reason = getErrorReason(data)
        if (reason === 'password_required') {
            status.value = 'password'
            return
        }
        if (reason === 'invalid_password') {
            status.value = 'password'
            passwordError.value = t('emailVerification.passwordIncorrect')
            return
        }
        // A network failure while the password form is open: keep the form for another try.
        if (status.value === 'password' && error.transportCode === 0) {
            passwordError.value = error.message
            return
        }
        const known = reason === undefined ? undefined : ERROR_MESSAGES[reason]
        status.value = 'error'
        message.value = known?.() ?? (error.message || t('emailVerification.invalid'))
        return
    }

    if (data?.status !== 'success') {
        status.value = 'error'
        message.value = data?.message || t('emailVerification.invalid')
        return
    }

    // The link is spent: nothing of it stays in the browser.
    clearUrlToken(route.path)
    status.value = 'success'
    message.value = data.message || t('emailVerification.success')
    password.value = ''

    if (userStore.user) {
        const { data: initData, error: initError } = await mainApi.init()
        if (!initError && initData?.status === 'ok' && initData.user) {
            userStore.setUser(initData.user)
        }
    }
}

function submitPassword(): void {
    if (isSubmitting.value) return
    if (password.value === '') {
        passwordError.value = t('emailVerification.passwordEmpty')
        return
    }
    void verifyEmail(password.value)
}

function goToAccount(): void {
    void router.push({ name: 'UserAccount' })
}

function goToLogin(): void {
    void router.push({ name: 'Login' })
}

function handleSuccessAction(): void {
    if (userStore.user) {
        goToAccount()
        return
    }

    goToLogin()
}

onMounted(() => {
    void verifyEmail()
})
</script>

<template>
    <div class="verify-email-page">
        <div class="verify-email-card">
            <p v-if="status === 'loading'" class="verify-email-state">
                {{ t('emailVerification.loading') }}
            </p>

            <form
                v-else-if="status === 'password'"
                class="verify-email-form"
                novalidate
                @submit.prevent="submitPassword"
            >
                <h1>{{ t('emailVerification.confirm') }}</h1>
                <p class="verify-email-message">{{ t('emailVerification.passwordPrompt') }}</p>
                <label class="verify-email-label" for="verify-email-password">
                    {{ t('emailVerification.passwordLabel') }}
                </label>
                <input
                    id="verify-email-password"
                    v-model="password"
                    class="verify-email-input"
                    type="password"
                    name="password"
                    autocomplete="current-password"
                    :maxlength="PASSWORD_MAX_LENGTH"
                    :aria-invalid="passwordError !== ''"
                    :aria-describedby="passwordError ? 'verify-email-password-error' : undefined"
                />
                <p
                    v-if="passwordError"
                    id="verify-email-password-error"
                    class="verify-email-error"
                    role="alert"
                >
                    {{ passwordError }}
                </p>
                <div class="verify-email-actions">
                    <button type="submit" class="verify-email-primary" :disabled="isSubmitting">
                        {{ t('emailVerification.confirm') }}
                    </button>
                </div>
            </form>

            <template v-else-if="status === 'success'">
                <h1>{{ t('emailVerification.successTitle') }}</h1>
                <p class="verify-email-message">{{ message }}</p>
                <div class="verify-email-actions">
                    <button class="verify-email-primary" @click="handleSuccessAction">
                        {{
                            userStore.user
                                ? t('emailVerification.openAccount')
                                : t('emailVerification.goToLogin')
                        }}
                    </button>
                </div>
            </template>

            <template v-else>
                <h1>{{ t('emailVerification.errorTitle') }}</h1>
                <p class="verify-email-message">{{ message }}</p>
                <div class="verify-email-actions">
                    <button class="verify-email-primary" @click="goToLogin">
                        {{ t('emailVerification.goToLogin') }}
                    </button>
                </div>
            </template>
        </div>
    </div>
</template>

<style scoped>
.verify-email-page {
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

.verify-email-card {
    width: min(100%, 520px);
    padding: 32px;
    border-radius: 20px;
    background: var(--surface-color);
    box-shadow: var(--shadow-md);
    text-align: center;
}

.verify-email-card h1 {
    margin: 0 0 12px;
    color: var(--text-primary);
    font-size: 2rem;
}

.verify-email-state,
.verify-email-message {
    margin: 0;
    color: var(--text-secondary);
    line-height: 1.6;
}

.verify-email-actions {
    margin-top: 24px;
    display: flex;
    justify-content: center;
}

.verify-email-primary {
    border: none;
    border-radius: 12px;
    background: var(--primary-color);
    color: #fff;
    padding: 12px 18px;
    font-weight: 600;
    cursor: pointer;
}

.verify-email-primary:hover {
    background: var(--primary-hover);
}

.verify-email-primary:disabled {
    opacity: 0.6;
    cursor: not-allowed;
}

.verify-email-form {
    display: flex;
    flex-direction: column;
    text-align: left;
}

.verify-email-form h1,
.verify-email-form .verify-email-message {
    text-align: center;
}

.verify-email-label {
    margin-top: 20px;
    margin-bottom: 6px;
    color: var(--text-primary);
    font-weight: 600;
}

.verify-email-input {
    padding: 12px;
    border: 1px solid var(--border-color);
    border-radius: 10px;
    background: var(--bg-primary);
    color: var(--text-primary);
    font-size: 1rem;
}

.verify-email-error {
    margin: 8px 0 0;
    color: #dc3545;
}
</style>
