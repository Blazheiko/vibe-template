<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ErrorCode } from 'shared/errors'
import { authApi } from '@/utils/api'
import { getResponseMessage, hasResponseError } from '@/utils/response-normalizer'
import { isEmail, looksLikeIdentifierPhone } from '@/utils/auth-identifiers'
import { isPhoneAuthEnabled } from '@/utils/phone-auth'
import { passwordLengthProblem } from '@/utils/validate-password'
import { useAuthRequest } from '@/composables/useAuthRequest'
import { useCompleteSignIn } from '@/composables/useCompleteSignIn'
import SocialAuthButtons from '../SocialAuthButtons.vue'

// The sign-in step of the login modal. The typed identifier and password belong to the modal (the
// forgot-password step starts from the identifier and coming back must not lose either), the rest
// is this form's.
const props = defineProps<{
    token: string
    /** A message to show at first, such as "password updated, sign in with the new one". */
    notice: string
}>()

const emit = defineEmits<{ forgot: []; register: []; 'signed-in': [] }>()

const loginIdentifier = defineModel<string>('identifier', { required: true })
const loginPassword = defineModel<string>('password', { required: true })

const { t } = useI18n()
const { runAuthRequest } = useAuthRequest()
const completeSignIn = useCompleteSignIn(() => {
    emit('signed-in')
})

const phoneAuthEnabled = isPhoneAuthEnabled()

const loginIdentifierError = ref('')
const loginPasswordError = ref('')
const loginError = ref(props.notice)
const isLoginLoading = ref(false)

function validateLoginIdentifier(): boolean {
    const value = loginIdentifier.value.trim()
    loginIdentifierError.value = ''

    if (value === '') {
        loginIdentifierError.value = phoneAuthEnabled
            ? t('auth.errorIdentifier')
            : t('auth.errorEmail')
        return false
    }

    if (!phoneAuthEnabled && !isEmail(value)) {
        loginIdentifierError.value = t('auth.errorEmailInvalid')
        return false
    }

    if (phoneAuthEnabled && !isEmail(value) && !looksLikeIdentifierPhone(value)) {
        loginIdentifierError.value = t('auth.errorIdentifierInvalid')
        return false
    }

    return true
}

function validateLoginPassword(): boolean {
    loginPasswordError.value = ''
    if (loginPassword.value === '') {
        loginPasswordError.value = t('auth.errorPassword')
        return false
    }

    if (passwordLengthProblem(loginPassword.value) === 'tooShort') {
        loginPasswordError.value = t('auth.errorPasswordLength')
        return false
    }

    return true
}

async function handleLogin(): Promise<void> {
    loginError.value = ''
    loginIdentifierError.value = ''
    loginPasswordError.value = ''

    const isValid = validateLoginIdentifier() && validateLoginPassword()
    if (!isValid) return

    await runAuthRequest(isLoginLoading, loginError, 'Login', async () => {
        const { data, error } = await authApi.login({
            identifier: loginIdentifier.value.trim(),
            password: loginPassword.value,
            token: props.token,
        })

        const unauthorized =
            error !== null && (error.code === ErrorCode.Unauthorized || error.transportCode === 401)

        if (error || hasResponseError(data)) {
            loginError.value = getResponseMessage(data, error?.message ?? t('auth.errorServer'))
            if (unauthorized) {
                loginError.value = t('auth.errorInvalidLogin')
            }
            return
        }

        if (data?.status === 'success' && data.user) {
            completeSignIn(data.user)
            return
        }

        loginError.value = t('auth.errorServer')
    })
}
</script>

<template>
    <p class="auth-description">
        {{ phoneAuthEnabled ? t('auth.identifierLoginHelp') : t('auth.emailLoginHelp') }}
    </p>
    <div v-if="loginError" class="error-message form-error">{{ loginError }}</div>
    <div class="form-group">
        <label for="login-identifier">
            {{ phoneAuthEnabled ? t('auth.identifier') : t('auth.email') }}
        </label>
        <input
            id="login-identifier"
            v-model="loginIdentifier"
            type="text"
            :placeholder="
                phoneAuthEnabled ? t('auth.identifierPlaceholder') : t('auth.emailPlaceholder')
            "
            autocomplete="username"
            :class="{ 'has-error': loginIdentifierError }"
        />
        <div v-if="loginIdentifierError" class="error-message">
            {{ loginIdentifierError }}
        </div>
    </div>
    <div class="form-group">
        <label for="login-password">{{ t('auth.password') }}</label>
        <input
            id="login-password"
            v-model="loginPassword"
            type="password"
            :placeholder="t('auth.passwordPlaceholder')"
            autocomplete="current-password"
            :class="{ 'has-error': loginPasswordError }"
        />
        <div v-if="loginPasswordError" class="error-message">
            {{ loginPasswordError }}
        </div>
    </div>

    <div class="form-options">
        <label class="checkbox-container">
            <input type="checkbox" checked />
            <span class="checkmark"></span>
            {{ t('auth.rememberMe') }}
        </label>
        <a href="#" class="forgot-password" @click.prevent="emit('forgot')">
            {{ t('auth.forgotPassword') }}
        </a>
    </div>

    <button class="auth-button" @click="handleLogin" :disabled="isLoginLoading">
        <span v-if="isLoginLoading">{{ t('auth.signingIn') }}</span>
        <span v-else>{{ t('auth.signIn') }}</span>
    </button>

    <SocialAuthButtons />

    <p class="auth-switch">
        {{ t('auth.noAccount') }}
        <a href="#" @click.prevent="emit('register')">{{ t('auth.register') }}</a>
    </p>
</template>
