<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { authApi } from '@/utils/api'
import { isEmail } from '@/utils/auth-identifiers'
import { passwordFieldMessage } from '@/utils/validate-password'
import { useAuthRequest } from '@/composables/useAuthRequest'
import { useCompleteSignIn } from '@/composables/useCompleteSignIn'
import SocialAuthButtons from '../SocialAuthButtons.vue'

// Registration by e-mail: name, address, password, the terms. With strict registration the answer
// is only a message ("check your inbox") and nobody is signed in yet; otherwise the new user is.
const props = defineProps<{ token: string }>()

const emit = defineEmits<{ login: []; 'signed-in': [] }>()

const { t } = useI18n()
const { runAuthRequest, failureMessage } = useAuthRequest()
const completeSignIn = useCompleteSignIn(() => {
    emit('signed-in')
})

const registerName = ref('')
const registerEmail = ref('')
const registerPassword = ref('')
const registerPasswordConfirm = ref('')
const registerError = ref('')
const registerNameError = ref('')
const registerEmailError = ref('')
const registerPasswordError = ref('')
const registerPasswordConfirmError = ref('')
const agreeToManifesto = ref(false)
const showAgreementError = ref(false)
const isRegisterLoading = ref(false)

function validateEmailRegister(): boolean {
    let ok = true
    registerNameError.value = ''
    registerEmailError.value = ''
    registerPasswordError.value = ''
    registerPasswordConfirmError.value = ''
    showAgreementError.value = false

    if (registerName.value.trim() === '') {
        registerNameError.value = t('auth.errorName')
        ok = false
    }

    if (registerEmail.value.trim() === '') {
        registerEmailError.value = t('auth.errorEmail')
        ok = false
    } else if (!isEmail(registerEmail.value)) {
        registerEmailError.value = t('auth.errorEmailInvalid')
        ok = false
    }

    registerPasswordError.value = passwordFieldMessage(registerPassword.value, t)
    if (registerPasswordError.value !== '') {
        ok = false
    }

    if (registerPassword.value !== registerPasswordConfirm.value) {
        registerPasswordConfirmError.value = t('auth.errorPasswordsMismatch')
        ok = false
    }

    if (!agreeToManifesto.value) {
        showAgreementError.value = true
        ok = false
    }

    return ok
}

async function handleEmailRegister(): Promise<void> {
    registerError.value = ''
    if (!validateEmailRegister()) return

    await runAuthRequest(isRegisterLoading, registerError, 'Email registration', async () => {
        const { data, error } = await authApi.registerEmail({
            name: registerName.value.trim(),
            email: registerEmail.value.trim(),
            password: registerPassword.value,
            token: props.token,
        })

        const failure = failureMessage(data, error)
        if (failure !== null) {
            registerError.value = failure
            return
        }

        if (data?.status === 'success' && data.user) {
            completeSignIn(data.user)
            return
        }

        if (data?.status === 'success' && data.message) {
            registerError.value = data.message
            return
        }

        registerError.value = t('auth.errorServer')
    })
}

function handleSocialAuth(url: string): void {
    if (!agreeToManifesto.value) {
        showAgreementError.value = true
        return
    }

    window.location.href = url
}
</script>

<template>
    <div v-if="registerError" class="error-message form-error">
        {{ registerError }}
    </div>
    <div class="form-group">
        <label for="register-name">{{ t('auth.name') }}</label>
        <input
            id="register-name"
            v-model="registerName"
            type="text"
            :placeholder="t('auth.namePlaceholder')"
            autocomplete="name"
            :class="{ 'has-error': registerNameError }"
        />
        <div v-if="registerNameError" class="error-message">
            {{ registerNameError }}
        </div>
    </div>
    <div class="form-group">
        <label for="register-email">{{ t('auth.email') }}</label>
        <input
            id="register-email"
            v-model="registerEmail"
            type="email"
            :placeholder="t('auth.emailPlaceholder')"
            autocomplete="email"
            :class="{ 'has-error': registerEmailError }"
        />
        <div v-if="registerEmailError" class="error-message">
            {{ registerEmailError }}
        </div>
    </div>
    <div class="form-group">
        <label for="register-password">{{ t('auth.password') }}</label>
        <input
            id="register-password"
            v-model="registerPassword"
            type="password"
            :placeholder="t('auth.passwordPlaceholder')"
            autocomplete="new-password"
            :class="{ 'has-error': registerPasswordError }"
        />
        <div v-if="registerPasswordError" class="error-message">
            {{ registerPasswordError }}
        </div>
    </div>
    <div class="form-group">
        <label for="register-password-confirm">{{ t('auth.confirmPassword') }}</label>
        <input
            id="register-password-confirm"
            v-model="registerPasswordConfirm"
            type="password"
            :placeholder="t('auth.confirmNewPassword')"
            autocomplete="new-password"
            :class="{ 'has-error': registerPasswordConfirmError }"
        />
        <div v-if="registerPasswordConfirmError" class="error-message">
            {{ registerPasswordConfirmError }}
        </div>
    </div>
    <div class="form-group terms-agreement" :class="{ 'has-error': showAgreementError }">
        <label class="checkbox-container">
            <input type="checkbox" v-model="agreeToManifesto" />
            <span class="checkmark"></span>
            {{ t('auth.termsAgreeText') }}
        </label>
        <p class="error-message" v-if="showAgreementError">
            {{ t('auth.errorTerms') }}
        </p>
    </div>
    <button class="auth-button" @click="handleEmailRegister" :disabled="isRegisterLoading">
        <span v-if="isRegisterLoading">{{ t('auth.createAccount') }}</span>
        <span v-else>{{ t('auth.createAccount') }}</span>
    </button>
    <SocialAuthButtons intercept-click @select="handleSocialAuth" />
    <p class="auth-switch">
        {{ t('auth.alreadyHaveAccount') }}
        <a href="#" @click.prevent="emit('login')">{{ t('auth.signIn') }}</a>
    </p>
</template>
