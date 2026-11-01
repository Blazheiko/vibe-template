<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { authApi } from '@/utils/api'
import { getResponseMessage, hasResponseError } from '@/utils/response-normalizer'
import { isEmail, looksLikeIdentifierPhone } from '@/utils/auth-identifiers'
import { isPhoneAuthEnabled } from '@/utils/phone-auth'
import { passwordLengthProblem } from '@/utils/validate-password'
import { useAuthRequest } from '@/composables/useAuthRequest'

// The "forgot password" part of the login modal: ask for a reset link (or an SMS code for a phone
// number), and for a phone number set the new password with the code. `step` is the modal's to
// show in its title; what is typed here is thrown away with the component.
const props = defineProps<{
    /** What was typed in the sign-in step, to start from. */
    identifier: string
}>()

const emit = defineEmits<{ back: []; 'reset-success': [] }>()

const step = defineModel<'email' | 'phone' | 'sent'>('step', { required: true })

const { t } = useI18n()
const { runAuthRequest } = useAuthRequest()
const phoneAuthEnabled = isPhoneAuthEnabled()

const forgotIdentifier = ref(props.identifier.trim())
const forgotIdentifierError = ref('')
const forgotError = ref('')
const forgotLoading = ref(false)
const forgotPhoneChallengeId = ref('')
const forgotPhoneCode = ref('')
const forgotPhonePassword = ref('')
const forgotPhonePasswordConfirm = ref('')
const forgotPhoneCodeError = ref('')
const forgotPhonePasswordError = ref('')
const forgotPhonePasswordConfirmError = ref('')

function validateForgotIdentifier(): boolean {
    const value = forgotIdentifier.value.trim()
    forgotIdentifierError.value = ''

    if (value === '') {
        forgotIdentifierError.value = phoneAuthEnabled
            ? t('auth.errorIdentifier')
            : t('auth.errorEmail')
        return false
    }

    if (!isEmail(value)) {
        if (!phoneAuthEnabled) {
            forgotIdentifierError.value = t('auth.errorEmailInvalid')
            return false
        }

        if (!looksLikeIdentifierPhone(value)) {
            forgotIdentifierError.value = t('auth.errorIdentifierInvalid')
            return false
        }
    }

    return true
}

async function handleForgotPassword(): Promise<void> {
    forgotError.value = ''
    forgotIdentifierError.value = ''

    if (!validateForgotIdentifier()) return

    if (looksLikeIdentifierPhone(forgotIdentifier.value)) {
        await runAuthRequest(forgotLoading, forgotError, 'Phone password recovery', async () => {
            const { data, error } = await authApi.startPhonePasswordReset({
                phone: forgotIdentifier.value.trim(),
            })

            const transportCode = error?.transportCode
            if (transportCode === 429) {
                forgotError.value = t('auth.errorTooManyResetRequests')
                return
            }

            if (error || hasResponseError(data) || data?.status !== 'success') {
                forgotError.value = getResponseMessage(
                    data,
                    error?.message ?? t('auth.errorServer'),
                )
                return
            }

            if (data.challengeId) {
                forgotPhoneChallengeId.value = data.challengeId
                step.value = 'phone'
                return
            }

            step.value = 'sent'
        })
        return
    }

    await runAuthRequest(forgotLoading, forgotError, 'Password recovery', async () => {
        const { error } = await authApi.forgotPassword({
            email: forgotIdentifier.value.trim(),
        })

        const transportCode = error?.transportCode
        if (transportCode === 429) {
            forgotError.value = t('auth.errorTooManyResetRequests')
            return
        }

        if (
            error &&
            (transportCode === 0 || (typeof transportCode === 'number' && transportCode >= 500))
        ) {
            forgotError.value = getResponseMessage(undefined, t('auth.errorServer'))
            return
        }

        step.value = 'sent'
    })
}

function backFromPhoneRecovery(): void {
    step.value = 'email'
    forgotError.value = ''
    forgotIdentifierError.value = ''
    forgotPhoneChallengeId.value = ''
    forgotPhoneCode.value = ''
    forgotPhonePassword.value = ''
    forgotPhonePasswordConfirm.value = ''
    forgotPhoneCodeError.value = ''
    forgotPhonePasswordError.value = ''
    forgotPhonePasswordConfirmError.value = ''
}

function validateForgotPhoneReset(): boolean {
    forgotPhoneCodeError.value = ''
    forgotPhonePasswordError.value = ''
    forgotPhonePasswordConfirmError.value = ''

    let valid = true
    if (forgotPhoneCode.value.trim() === '') {
        forgotPhoneCodeError.value = t('auth.errorVerificationCode')
        valid = false
    }

    // An empty field reads "too short" here, as it always did, not "required".
    const forgotProblem = passwordLengthProblem(forgotPhonePassword.value)
    if (forgotProblem !== null) {
        forgotPhonePasswordError.value =
            forgotProblem === 'tooLong'
                ? t('auth.errorPasswordMaxLength')
                : t('auth.errorPasswordLength')
        valid = false
    }

    if (forgotPhonePassword.value !== forgotPhonePasswordConfirm.value) {
        forgotPhonePasswordConfirmError.value = t('auth.errorPasswordsMismatch')
        valid = false
    }

    return valid
}

async function handleForgotPhoneReset(): Promise<void> {
    forgotError.value = ''
    if (!validateForgotPhoneReset()) return

    await runAuthRequest(forgotLoading, forgotError, 'Phone password reset', async () => {
        const { data, error } = await authApi.completePhonePasswordReset({
            challengeId: forgotPhoneChallengeId.value,
            code: forgotPhoneCode.value.trim(),
            password: forgotPhonePassword.value,
            passwordConfirm: forgotPhonePasswordConfirm.value,
        })

        if (error || hasResponseError(data) || data?.status !== 'success') {
            forgotError.value = getResponseMessage(data, error?.message ?? t('auth.errorServer'))
            return
        }

        emit('reset-success')
    })
}
</script>

<template>
    <template v-if="step === 'email'">
        <p class="auth-description">{{ t('auth.resetPasswordDescription') }}</p>
        <div v-if="forgotError" class="error-message form-error">{{ forgotError }}</div>
        <div class="form-group">
            <label for="forgot-identifier">
                {{ phoneAuthEnabled ? t('auth.identifier') : t('auth.email') }}
            </label>
            <input
                id="forgot-identifier"
                v-model="forgotIdentifier"
                type="text"
                :placeholder="
                    phoneAuthEnabled ? t('auth.identifierPlaceholder') : t('auth.emailPlaceholder')
                "
                autocomplete="username"
                :class="{ 'has-error': forgotIdentifierError }"
            />
            <div v-if="forgotIdentifierError" class="error-message">
                {{ forgotIdentifierError }}
            </div>
        </div>

        <button class="auth-button" @click="handleForgotPassword" :disabled="forgotLoading">
            <span v-if="forgotLoading">{{ t('auth.sendingResetLink') }}</span>
            <span v-else>{{ t('auth.sendResetLink') }}</span>
        </button>

        <p class="auth-switch">
            <a href="#" @click.prevent="emit('back')">{{ t('auth.backToLogin') }}</a>
        </p>
    </template>

    <template v-else-if="step === 'phone'">
        <p class="auth-description">
            {{ t('auth.phoneRecoveryDescription') }}
        </p>
        <div v-if="forgotError" class="error-message form-error">{{ forgotError }}</div>
        <div class="form-group">
            <label for="forgot-phone-code">{{ t('auth.verificationCode') }}</label>
            <input
                id="forgot-phone-code"
                v-model="forgotPhoneCode"
                type="text"
                :placeholder="t('auth.verificationCodePlaceholder')"
                :class="{ 'has-error': forgotPhoneCodeError }"
            />
            <div v-if="forgotPhoneCodeError" class="error-message">
                {{ forgotPhoneCodeError }}
            </div>
        </div>
        <div class="form-group">
            <label for="forgot-phone-password">{{ t('auth.newPassword') }}</label>
            <input
                id="forgot-phone-password"
                v-model="forgotPhonePassword"
                type="password"
                :placeholder="t('auth.passwordPlaceholder')"
                autocomplete="new-password"
                :class="{ 'has-error': forgotPhonePasswordError }"
            />
            <div v-if="forgotPhonePasswordError" class="error-message">
                {{ forgotPhonePasswordError }}
            </div>
        </div>
        <div class="form-group">
            <label for="forgot-phone-password-confirm">{{ t('auth.confirmNewPassword') }}</label>
            <input
                id="forgot-phone-password-confirm"
                v-model="forgotPhonePasswordConfirm"
                type="password"
                :placeholder="t('auth.passwordPlaceholder')"
                autocomplete="new-password"
                :class="{ 'has-error': forgotPhonePasswordConfirmError }"
            />
            <div v-if="forgotPhonePasswordConfirmError" class="error-message">
                {{ forgotPhonePasswordConfirmError }}
            </div>
        </div>
        <button class="auth-button" @click="handleForgotPhoneReset" :disabled="forgotLoading">
            <span v-if="forgotLoading">{{ t('auth.settingNewPassword') }}</span>
            <span v-else>{{ t('auth.setNewPassword') }}</span>
        </button>
        <button class="auth-button secondary" @click="backFromPhoneRecovery">
            {{ t('auth.backToEmailRecovery') }}
        </button>
    </template>

    <template v-else>
        <p class="auth-description auth-description-centered">
            {{ t('auth.resetLinkSentDescription') }}
        </p>
        <p class="auth-switch">
            <a href="#" @click.prevent="emit('back')">{{ t('auth.backToLogin') }}</a>
        </p>
    </template>
</template>
