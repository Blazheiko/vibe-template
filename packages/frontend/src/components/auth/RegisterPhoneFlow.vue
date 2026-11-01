<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { looksLikePhoneNumber } from 'shared/patterns'
import { authApi } from '@/utils/api'
import { passwordFieldMessage } from '@/utils/validate-password'
import { useAuthRequest } from '@/composables/useAuthRequest'
import { useCompleteSignIn } from '@/composables/useCompleteSignIn'

// Registration by phone, in three steps: the number (a code is sent), the code, then name and
// password. A step back goes to the one before; from the first it goes back to the choice.
const props = defineProps<{ token: string }>()

const emit = defineEmits<{ back: []; 'signed-in': [] }>()

const { t } = useI18n()
const { runAuthRequest, failureMessage } = useAuthRequest()
const completeSignIn = useCompleteSignIn(() => {
    emit('signed-in')
})

const step = ref<'start' | 'confirm' | 'complete'>('start')

const registerPhone = ref('')
const registerPhoneCountry = ref('')
const registerPhoneCode = ref('')
const registerName = ref('')
const registerPassword = ref('')
const registerPasswordConfirm = ref('')
const registerError = ref('')
const registerNameError = ref('')
const registerPasswordError = ref('')
const registerPasswordConfirmError = ref('')
const registerPhoneError = ref('')
const registerCodeError = ref('')
const agreeToManifesto = ref(false)
const showAgreementError = ref(false)
const isRegisterLoading = ref(false)
const phoneChallengeId = ref('')
const phoneChallengeExpiresAt = ref('')
const phoneResendAvailableAt = ref('')

function validatePhoneStart(): boolean {
    registerPhoneError.value = ''

    if (registerPhone.value.trim() === '') {
        registerPhoneError.value = t('auth.errorPhone')
        return false
    }

    if (!looksLikePhoneNumber(registerPhone.value)) {
        registerPhoneError.value = t('auth.errorPhoneInvalid')
        return false
    }

    return true
}

async function handlePhoneStart(): Promise<void> {
    registerError.value = ''
    if (!validatePhoneStart()) return

    await runAuthRequest(isRegisterLoading, registerError, 'Phone registration start', async () => {
        const { data, error } = await authApi.registerPhoneStart({
            phone: registerPhone.value.trim(),
            defaultCountry: registerPhoneCountry.value.trim() || undefined,
        })

        const failure = failureMessage(data, error)
        if (failure !== null) {
            registerError.value = failure
            return
        }

        if (data?.status === 'success') {
            phoneChallengeId.value = data.challengeId
            phoneChallengeExpiresAt.value = data.expiresAt
            phoneResendAvailableAt.value = data.resendAvailableAt
            step.value = 'confirm'
            return
        }

        registerError.value = t('auth.errorServer')
    })
}

function validatePhoneConfirm(): boolean {
    registerCodeError.value = ''
    if (registerPhoneCode.value.trim() === '') {
        registerCodeError.value = t('auth.errorVerificationCode')
        return false
    }

    return true
}

async function handlePhoneConfirm(): Promise<void> {
    registerError.value = ''
    if (!validatePhoneConfirm()) return

    await runAuthRequest(
        isRegisterLoading,
        registerError,
        'Phone registration confirmation',
        async () => {
            const { data, error } = await authApi.registerPhoneConfirm({
                challengeId: phoneChallengeId.value,
                code: registerPhoneCode.value.trim(),
            })

            const failure = failureMessage(data, error)
            if (failure !== null) {
                registerError.value = failure
                return
            }

            if (data?.status === 'success') {
                step.value = 'complete'
                return
            }

            registerError.value = t('auth.errorServer')
        },
    )
}

function validatePhoneComplete(): boolean {
    let ok = true
    registerNameError.value = ''
    registerPasswordError.value = ''
    registerPasswordConfirmError.value = ''
    showAgreementError.value = false

    if (registerName.value.trim() === '') {
        registerNameError.value = t('auth.errorName')
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

async function handlePhoneComplete(): Promise<void> {
    registerError.value = ''
    if (!validatePhoneComplete()) return

    await runAuthRequest(
        isRegisterLoading,
        registerError,
        'Phone registration completion',
        async () => {
            const { data, error } = await authApi.registerPhoneComplete({
                challengeId: phoneChallengeId.value,
                name: registerName.value.trim(),
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

            registerError.value = t('auth.errorServer')
        },
    )
}
</script>

<template>
    <template v-if="step === 'start'">
        <p class="auth-description">{{ t('auth.phoneRegisterStartDescription') }}</p>
        <div v-if="registerError" class="error-message form-error">
            {{ registerError }}
        </div>
        <div class="form-group">
            <label for="register-phone">{{ t('auth.phone') }}</label>
            <input
                id="register-phone"
                v-model="registerPhone"
                type="tel"
                :placeholder="t('auth.phonePlaceholder')"
                autocomplete="tel"
                :class="{ 'has-error': registerPhoneError }"
            />
            <div v-if="registerPhoneError" class="error-message">
                {{ registerPhoneError }}
            </div>
        </div>
        <div class="form-group">
            <label for="register-phone-country">{{ t('auth.phoneCountryOptional') }}</label>
            <input
                id="register-phone-country"
                v-model="registerPhoneCountry"
                type="text"
                maxlength="2"
                placeholder="US"
                autocomplete="country"
            />
        </div>
        <button class="auth-button" @click="handlePhoneStart" :disabled="isRegisterLoading">
            <span v-if="isRegisterLoading">{{ t('auth.sendingResetLink') }}</span>
            <span v-else>{{ t('auth.sendVerificationCode') }}</span>
        </button>
        <p class="auth-switch">
            <a href="#" @click.prevent="emit('back')">{{ t('auth.back') }}</a>
        </p>
    </template>

    <template v-else-if="step === 'confirm'">
        <p class="auth-description">{{ t('auth.phoneRegisterConfirmDescription') }}</p>
        <div v-if="registerError" class="error-message form-error">
            {{ registerError }}
        </div>
        <div class="callout callout--info">
            <div>{{ t('auth.challengeId') }}: {{ phoneChallengeId }}</div>
            <div v-if="phoneChallengeExpiresAt">
                {{ t('auth.expiresAt') }}: {{ phoneChallengeExpiresAt }}
            </div>
        </div>
        <div class="form-group">
            <label for="register-phone-code">{{ t('auth.verificationCode') }}</label>
            <input
                id="register-phone-code"
                v-model="registerPhoneCode"
                type="text"
                inputmode="numeric"
                :placeholder="t('auth.verificationCodePlaceholder')"
                :class="{ 'has-error': registerCodeError }"
            />
            <div v-if="registerCodeError" class="error-message">
                {{ registerCodeError }}
            </div>
        </div>
        <button class="auth-button" @click="handlePhoneConfirm" :disabled="isRegisterLoading">
            <span v-if="isRegisterLoading">{{ t('auth.verifyingCode') }}</span>
            <span v-else>{{ t('auth.verifyCode') }}</span>
        </button>
        <p class="auth-switch">
            <a href="#" @click.prevent="step = 'start'">{{ t('auth.back') }}</a>
        </p>
        <p v-if="phoneResendAvailableAt" class="auth-description">
            {{ t('auth.resendAvailableAt') }}: {{ phoneResendAvailableAt }}
        </p>
    </template>

    <template v-else>
        <p class="auth-description">{{ t('auth.phoneRegisterCompleteDescription') }}</p>
        <div v-if="registerError" class="error-message form-error">
            {{ registerError }}
        </div>
        <div class="form-group">
            <label for="register-phone-name">{{ t('auth.name') }}</label>
            <input
                id="register-phone-name"
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
            <label for="register-phone-password">{{ t('auth.password') }}</label>
            <input
                id="register-phone-password"
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
            <label for="register-phone-password-confirm">{{ t('auth.confirmPassword') }}</label>
            <input
                id="register-phone-password-confirm"
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
        <button class="auth-button" @click="handlePhoneComplete" :disabled="isRegisterLoading">
            <span v-if="isRegisterLoading">{{ t('auth.createAccount') }}</span>
            <span v-else>{{ t('auth.createAccount') }}</span>
        </button>
        <p class="auth-switch">
            <a href="#" @click.prevent="step = 'confirm'">{{ t('auth.back') }}</a>
        </p>
    </template>
</template>
