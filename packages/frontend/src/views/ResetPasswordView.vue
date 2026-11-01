<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { authApi } from '@/utils/api'
import { getResponseMessage, hasErrorCode, hasResponseError } from '@/utils/response-normalizer'
import { ErrorCode } from 'shared/errors'
import { PASSWORD_PROBLEM_MESSAGE_KEY, passwordLengthProblem } from '@/utils/validate-password'

defineOptions({
    name: 'ResetPasswordView',
})

type ViewStatus = 'loading' | 'ready' | 'submitting' | 'success' | 'error'

const route = useRoute()
const router = useRouter()
const { t } = useI18n()

const status = ref<ViewStatus>('loading')
const password = ref('')
const passwordConfirm = ref('')
const passwordError = ref('')
const passwordConfirmError = ref('')
const message = ref('')

const token = computed(() => {
    const rawToken = route.query.token
    return typeof rawToken === 'string' ? rawToken.trim() : ''
})

function validateForm(): boolean {
    let isValid = true
    passwordError.value = ''
    passwordConfirmError.value = ''

    const problem = passwordLengthProblem(password.value)
    if (problem !== null) {
        passwordError.value = t(PASSWORD_PROBLEM_MESSAGE_KEY[problem])
        isValid = false
    }

    const confirmProblem = passwordLengthProblem(passwordConfirm.value)
    if (confirmProblem !== null) {
        passwordConfirmError.value = t(PASSWORD_PROBLEM_MESSAGE_KEY[confirmProblem])
        isValid = false
    } else if (password.value !== passwordConfirm.value) {
        passwordConfirmError.value = t('auth.errorPasswordsMismatch')
        isValid = false
    }

    return isValid
}

async function submitResetPassword(): Promise<void> {
    if (status.value === 'submitting') return

    message.value = ''
    if (!validateForm()) return

    status.value = 'submitting'

    const { data, error } = await authApi.resetPassword({
        token: token.value,
        password: password.value,
        passwordConfirm: passwordConfirm.value,
    })

    if (error) {
        const transportCode = error.transportCode
        const reason = hasResponseError(data) && data?.status === 'error' ? data.reason : undefined
        const responseMessage = getResponseMessage(data, t('auth.errorServer'))

        if (transportCode === 0) {
            message.value = responseMessage || t('auth.errorServer')
            status.value = 'ready'
            return
        }

        if (hasErrorCode(data, ErrorCode.BadRequest) && reason === 'passwords_mismatch') {
            message.value = responseMessage || t('auth.errorServer')
            status.value = 'ready'
            return
        }

        status.value = hasErrorCode(data, ErrorCode.BadRequest) ? 'error' : 'ready'
        message.value = hasErrorCode(data, ErrorCode.BadRequest)
            ? responseMessage || t('auth.invalidResetToken')
            : responseMessage || t('auth.errorServer')
        return
    }

    if (hasResponseError(data) || data?.status !== 'success') {
        status.value = 'error'
        message.value = getResponseMessage(data, t('auth.invalidResetToken'))
        return
    }

    status.value = 'success'
    message.value = t('auth.resetPasswordSuccess')
}

function goToLogin(): void {
    void router.push({ name: 'Login' })
}

onMounted(() => {
    if (token.value === '') {
        status.value = 'error'
        message.value = t('auth.invalidResetToken')
        return
    }

    status.value = 'ready'
})
</script>

<template>
    <div class="reset-password-page">
        <div class="reset-password-card">
            <p v-if="status === 'loading'" class="reset-password-state">
                {{ t('common.loading') }}
            </p>

            <template v-else-if="status === 'success'">
                <h1>{{ t('auth.resetPasswordSuccessTitle') }}</h1>
                <p class="reset-password-message">{{ message }}</p>
                <div class="reset-password-actions">
                    <button class="reset-password-primary" @click="goToLogin">
                        {{ t('emailVerification.goToLogin') }}
                    </button>
                </div>
            </template>

            <template v-else-if="status === 'error'">
                <h1>{{ t('auth.resetPasswordTitle') }}</h1>
                <p class="reset-password-message">{{ message }}</p>
                <div class="reset-password-actions">
                    <button class="reset-password-primary" @click="goToLogin">
                        {{ t('emailVerification.goToLogin') }}
                    </button>
                </div>
            </template>

            <template v-else>
                <h1>{{ t('auth.resetPasswordTitle') }}</h1>
                <p class="reset-password-message">{{ t('auth.resetPasswordHelp') }}</p>

                <div v-if="message" class="reset-password-error">{{ message }}</div>

                <div class="reset-password-form">
                    <label for="reset-password">{{ t('auth.newPassword') }}</label>
                    <input
                        id="reset-password"
                        v-model="password"
                        type="password"
                        autocomplete="new-password"
                        :placeholder="t('auth.passwordPlaceholder')"
                        :disabled="status === 'submitting'"
                    />
                    <div v-if="passwordError" class="reset-password-field-error">
                        {{ passwordError }}
                    </div>

                    <label for="reset-password-confirm">{{ t('auth.confirmNewPassword') }}</label>
                    <input
                        id="reset-password-confirm"
                        v-model="passwordConfirm"
                        type="password"
                        autocomplete="new-password"
                        :placeholder="t('auth.confirmNewPassword')"
                        :disabled="status === 'submitting'"
                    />
                    <div v-if="passwordConfirmError" class="reset-password-field-error">
                        {{ passwordConfirmError }}
                    </div>
                </div>

                <div class="reset-password-actions">
                    <button
                        class="reset-password-primary"
                        @click="submitResetPassword"
                        :disabled="status === 'submitting'"
                    >
                        {{
                            status === 'submitting'
                                ? t('auth.settingNewPassword')
                                : t('auth.setNewPassword')
                        }}
                    </button>
                    <button class="reset-password-secondary" @click="goToLogin">
                        {{ t('auth.backToLogin') }}
                    </button>
                </div>
            </template>
        </div>
    </div>
</template>

<style scoped>
.reset-password-page {
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

.reset-password-card {
    width: min(100%, 520px);
    padding: 32px;
    border-radius: 20px;
    background: var(--surface-color);
    box-shadow: var(--shadow-md);
}

.reset-password-card h1 {
    margin: 0 0 12px;
    color: var(--text-primary);
    font-size: 2rem;
    text-align: center;
}

.reset-password-state,
.reset-password-message {
    margin: 0;
    color: var(--text-secondary);
    line-height: 1.6;
    text-align: center;
}

.reset-password-form {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-top: 24px;
}

.reset-password-form label {
    color: var(--text-primary);
    font-weight: 600;
}

.reset-password-form input {
    width: 100%;
    border: 1px solid var(--border-color);
    border-radius: 12px;
    padding: 12px 14px;
    font: inherit;
    color: var(--text-primary);
    background: var(--surface-color);
}

.reset-password-form input:focus {
    outline: none;
    border-color: var(--primary-color);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--primary-color) 18%, transparent);
}

.reset-password-form input:disabled {
    opacity: 0.7;
    cursor: not-allowed;
}

.reset-password-error,
.reset-password-field-error {
    color: var(--danger-color, #b83232);
    font-size: 0.95rem;
}

.reset-password-error {
    margin-top: 20px;
    text-align: center;
}

.reset-password-actions {
    margin-top: 24px;
    display: flex;
    flex-direction: column;
    gap: 12px;
}

.reset-password-primary,
.reset-password-secondary {
    border-radius: 12px;
    padding: 12px 18px;
    font-weight: 600;
    cursor: pointer;
    transition:
        background-color 0.2s ease,
        transform 0.2s ease;
}

.reset-password-primary {
    border: none;
    background: var(--primary-color);
    color: #fff;
}

.reset-password-primary:hover:not(:disabled) {
    background: var(--primary-hover, var(--accent-color));
    transform: translateY(-1px);
}

.reset-password-primary:disabled {
    opacity: 0.65;
    cursor: not-allowed;
}

.reset-password-secondary {
    border: 1px solid var(--border-color);
    background: transparent;
    color: var(--text-primary);
}

.reset-password-secondary:hover {
    background: color-mix(in srgb, var(--surface-color) 88%, var(--primary-color));
}

@media (max-width: 640px) {
    .reset-password-card {
        padding: 24px;
    }

    .reset-password-card h1 {
        font-size: 1.7rem;
    }
}
</style>
