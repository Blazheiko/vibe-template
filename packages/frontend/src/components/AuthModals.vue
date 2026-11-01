<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useEventBus } from '@/utils/event-bus'
import { authApi } from '@/utils/api'
import SocialAuthButtons from './SocialAuthButtons.vue'
import { useUserStore } from '@/stores/user'
import { getResponseMessage, hasResponseError } from '@/utils/response-normalizer'
import { ErrorCode } from 'shared/errors'
import { looksLikePhoneNumber } from 'shared/patterns'
import { PASSWORD_PROBLEM_MESSAGE_KEY, passwordLengthProblem } from '@/utils/validate-password'

const { t } = useI18n()
const router = useRouter()
const userStore = useUserStore()
const eventBus = useEventBus()

const phoneAuthEnabled = computed(() => import.meta.env.VITE_AUTH_PHONE_ENABLED === 'true')

const props = defineProps({
    showLogin: {
        type: Boolean,
        default: false,
    },
    showRegister: {
        type: Boolean,
        default: false,
    },
    token: {
        type: String,
        default: '',
    },
})

const emit = defineEmits(['close', 'show-login', 'show-register', 'auth-success'])

type LoginStep = 'login' | 'forgot-email' | 'forgot-phone' | 'forgot-sent'
type RegisterStep = 'choice' | 'email' | 'phone-start' | 'phone-confirm' | 'phone-complete'

const loginStep = ref<LoginStep>('login')
const registerStep = ref<RegisterStep>(phoneAuthEnabled.value ? 'choice' : 'email')

const loginIdentifier = ref('')
const loginPassword = ref('')
const loginIdentifierError = ref('')
const loginPasswordError = ref('')
const loginError = ref('')
const forgotIdentifier = ref('')
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

const registerName = ref('')
const registerEmail = ref('')
const registerPassword = ref('')
const registerPasswordConfirm = ref('')
const registerPhone = ref('')
const registerPhoneCountry = ref('')
const registerPhoneCode = ref('')
const registerError = ref('')
const registerNameError = ref('')
const registerEmailError = ref('')
const registerPasswordError = ref('')
const registerPasswordConfirmError = ref('')
const registerPhoneError = ref('')
const registerCodeError = ref('')
const registerChoiceError = ref('')
const agreeToManifesto = ref(false)
const showAgreementError = ref(false)
const isLoginLoading = ref(false)
const isRegisterLoading = ref(false)
const phoneChallengeId = ref('')
const phoneChallengeExpiresAt = ref('')
const phoneResendAvailableAt = ref('')

function isEmail(value: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
}

/** The message of a password that does not fit the limits, or '' when it does. */
function passwordFieldError(value: string): string {
    const problem = passwordLengthProblem(value)
    return problem === null ? '' : t(PASSWORD_PROBLEM_MESSAGE_KEY[problem])
}

function normalizeIdentifier(value: string): string {
    return value.trim()
}

function clearLoginState(): void {
    loginStep.value = 'login'
    loginIdentifier.value = ''
    loginPassword.value = ''
    loginIdentifierError.value = ''
    loginPasswordError.value = ''
    loginError.value = ''
    forgotIdentifier.value = ''
    forgotIdentifierError.value = ''
    forgotError.value = ''
    forgotLoading.value = false
    forgotPhoneChallengeId.value = ''
    forgotPhoneCode.value = ''
    forgotPhonePassword.value = ''
    forgotPhonePasswordConfirm.value = ''
    forgotPhoneCodeError.value = ''
    forgotPhonePasswordError.value = ''
    forgotPhonePasswordConfirmError.value = ''
}

function clearRegisterState(): void {
    registerStep.value = phoneAuthEnabled.value ? 'choice' : 'email'
    registerName.value = ''
    registerEmail.value = ''
    registerPassword.value = ''
    registerPasswordConfirm.value = ''
    registerPhone.value = ''
    registerPhoneCountry.value = ''
    registerPhoneCode.value = ''
    registerError.value = ''
    registerNameError.value = ''
    registerEmailError.value = ''
    registerPasswordError.value = ''
    registerPasswordConfirmError.value = ''
    registerPhoneError.value = ''
    registerCodeError.value = ''
    registerChoiceError.value = ''
    agreeToManifesto.value = false
    showAgreementError.value = false
    isRegisterLoading.value = false
    phoneChallengeId.value = ''
    phoneChallengeExpiresAt.value = ''
    phoneResendAvailableAt.value = ''
}

function closeLoginModal(): void {
    clearLoginState()
    emit('close')
}

function closeRegisterModal(): void {
    clearRegisterState()
    emit('close')
}

function openRegisterFlow(step: RegisterStep): void {
    clearRegisterState()
    registerStep.value = step
    emit('show-register')
}

function switchToRegister(): void {
    clearLoginState()
    openRegisterFlow(phoneAuthEnabled.value ? 'choice' : 'email')
}

function switchToLogin(): void {
    clearRegisterState()
    emit('show-login')
}

function looksLikeIdentifierPhone(value: string): boolean {
    const trimmed = value.trim()
    return looksLikePhoneNumber(trimmed) && !isEmail(trimmed)
}

function validateLoginIdentifier(): boolean {
    const value = loginIdentifier.value.trim()
    loginIdentifierError.value = ''

    if (value === '') {
        loginIdentifierError.value = phoneAuthEnabled.value
            ? t('auth.errorIdentifier')
            : t('auth.errorEmail')
        return false
    }

    if (!phoneAuthEnabled.value && !isEmail(value)) {
        loginIdentifierError.value = t('auth.errorEmailInvalid')
        return false
    }

    if (phoneAuthEnabled.value && !isEmail(value) && !looksLikeIdentifierPhone(value)) {
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

    isLoginLoading.value = true

    try {
        const identifier = normalizeIdentifier(loginIdentifier.value)
        const { data, error } = await authApi.login({
            identifier,
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
            userStore.setUser(data.user)
            emit('close')
            emit('auth-success')
            void router.push({ name: 'UserAccount' })
            eventBus.emit('init_app')
            return
        }

        loginError.value = t('auth.errorServer')
    } catch (error: unknown) {
        console.error('Login failed:', error)
        loginError.value = t('auth.errorServer')
    } finally {
        isLoginLoading.value = false
    }
}

function showForgotPasswordStep(): void {
    forgotIdentifier.value = loginIdentifier.value.trim()
    loginError.value = ''
    loginIdentifierError.value = ''
    loginPasswordError.value = ''
    forgotError.value = ''
    forgotIdentifierError.value = ''
    loginStep.value = phoneAuthEnabled.value ? 'forgot-email' : 'forgot-email'
}

function backToLoginStep(): void {
    forgotError.value = ''
    forgotIdentifierError.value = ''
    forgotLoading.value = false
    loginStep.value = 'login'
}

function validateForgotIdentifier(): boolean {
    const value = forgotIdentifier.value.trim()
    forgotIdentifierError.value = ''

    if (value === '') {
        forgotIdentifierError.value = phoneAuthEnabled.value
            ? t('auth.errorIdentifier')
            : t('auth.errorEmail')
        return false
    }

    if (!isEmail(value)) {
        if (!phoneAuthEnabled.value) {
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
        forgotLoading.value = true
        try {
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
                loginStep.value = 'forgot-phone'
                return
            }

            loginStep.value = 'forgot-sent'
            return
        } catch (error: unknown) {
            console.error('Phone password recovery failed:', error)
            forgotError.value = t('auth.errorServer')
            return
        } finally {
            forgotLoading.value = false
        }
    }

    forgotLoading.value = true

    try {
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

        loginStep.value = 'forgot-sent'
    } catch (error: unknown) {
        console.error('Password recovery failed:', error)
        forgotError.value = t('auth.errorServer')
    } finally {
        forgotLoading.value = false
    }
}

function backFromPhoneRecovery(): void {
    loginStep.value = 'forgot-email'
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

    forgotLoading.value = true
    try {
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

        loginStep.value = 'login'
        loginPassword.value = ''
        loginError.value = t('auth.phoneRecoveryResetSuccess')
        forgotPhoneChallengeId.value = ''
        forgotPhoneCode.value = ''
        forgotPhonePassword.value = ''
        forgotPhonePasswordConfirm.value = ''
        forgotIdentifier.value = ''
        loginIdentifier.value = ''
    } catch (error: unknown) {
        console.error('Phone password reset failed:', error)
        forgotError.value = t('auth.errorServer')
    } finally {
        forgotLoading.value = false
    }
}

function validateEmailRegister(): boolean {
    let ok = true
    registerNameError.value = ''
    registerEmailError.value = ''
    registerPasswordError.value = ''
    registerPasswordConfirmError.value = ''
    registerChoiceError.value = ''
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

    registerPasswordError.value = passwordFieldError(registerPassword.value)
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
    const isValid = validateEmailRegister()
    if (!isValid) return

    isRegisterLoading.value = true
    try {
        const { data, error } = await authApi.registerEmail({
            name: registerName.value.trim(),
            email: registerEmail.value.trim(),
            password: registerPassword.value,
            token: props.token,
        })

        if (error || hasResponseError(data)) {
            registerError.value = getResponseMessage(data, error?.message ?? t('auth.errorServer'))
            return
        }

        if (data?.status === 'success' && data.user) {
            userStore.setUser(data.user)
            emit('close')
            emit('auth-success')
            void router.push({ name: 'UserAccount' })
            eventBus.emit('init_app')
            return
        }

        if (data?.status === 'success' && data.message) {
            registerError.value = data.message
            return
        }

        registerError.value = t('auth.errorServer')
    } catch (error: unknown) {
        console.error('Email registration failed:', error)
        registerError.value = t('auth.errorServer')
    } finally {
        isRegisterLoading.value = false
    }
}

function validatePhoneStart(): boolean {
    registerPhoneError.value = ''
    registerChoiceError.value = ''

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

    isRegisterLoading.value = true
    try {
        const { data, error } = await authApi.registerPhoneStart({
            phone: registerPhone.value.trim(),
            defaultCountry: registerPhoneCountry.value.trim() || undefined,
        })

        if (error || hasResponseError(data)) {
            registerError.value = getResponseMessage(data, error?.message ?? t('auth.errorServer'))
            return
        }

        if (data?.status === 'success') {
            phoneChallengeId.value = data.challengeId
            phoneChallengeExpiresAt.value = data.expiresAt
            phoneResendAvailableAt.value = data.resendAvailableAt
            registerStep.value = 'phone-confirm'
            return
        }

        registerError.value = t('auth.errorServer')
    } catch (error: unknown) {
        console.error('Phone registration start failed:', error)
        registerError.value = t('auth.errorServer')
    } finally {
        isRegisterLoading.value = false
    }
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

    isRegisterLoading.value = true
    try {
        const { data, error } = await authApi.registerPhoneConfirm({
            challengeId: phoneChallengeId.value,
            code: registerPhoneCode.value.trim(),
        })

        if (error || hasResponseError(data)) {
            registerError.value = getResponseMessage(data, error?.message ?? t('auth.errorServer'))
            return
        }

        if (data?.status === 'success') {
            registerStep.value = 'phone-complete'
            return
        }

        registerError.value = t('auth.errorServer')
    } catch (error: unknown) {
        console.error('Phone registration confirmation failed:', error)
        registerError.value = t('auth.errorServer')
    } finally {
        isRegisterLoading.value = false
    }
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

    registerPasswordError.value = passwordFieldError(registerPassword.value)
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

    isRegisterLoading.value = true
    try {
        const { data, error } = await authApi.registerPhoneComplete({
            challengeId: phoneChallengeId.value,
            name: registerName.value.trim(),
            password: registerPassword.value,
            token: props.token,
        })

        if (error || hasResponseError(data)) {
            registerError.value = getResponseMessage(data, error?.message ?? t('auth.errorServer'))
            return
        }

        if (data?.status === 'success' && data.user) {
            userStore.setUser(data.user)
            emit('close')
            emit('auth-success')
            void router.push({ name: 'UserAccount' })
            eventBus.emit('init_app')
            return
        }

        registerError.value = t('auth.errorServer')
    } catch (error: unknown) {
        console.error('Phone registration completion failed:', error)
        registerError.value = t('auth.errorServer')
    } finally {
        isRegisterLoading.value = false
    }
}

function handleSocialAuth(url: string): void {
    if (!agreeToManifesto.value) {
        showAgreementError.value = true
        return
    }

    window.location.href = url
}

watch(
    () => props.showLogin,
    (visible) => {
        if (visible) {
            clearLoginState()
        }
    },
)

watch(
    () => props.showRegister,
    (visible) => {
        if (visible) {
            clearRegisterState()
        }
    },
)
</script>

<template>
    <div class="modal-overlay" :class="{ show: props.showLogin }">
        <div class="modal auth-modal">
            <div class="modal-header">
                <h3>
                    {{
                        loginStep === 'login'
                            ? t('auth.signIn')
                            : loginStep === 'forgot-phone'
                              ? t('auth.phoneRecoveryTitle')
                              : loginStep === 'forgot-sent'
                                ? t('auth.resetLinkSent')
                                : t('auth.resetPasswordTitle')
                    }}
                </h3>
                <button
                    class="close-modal"
                    @click="closeLoginModal"
                    :aria-label="t('auth.closeModal')"
                >
                    ×
                </button>
            </div>

            <div class="modal-content">
                <template v-if="loginStep === 'login'">
                    <p class="auth-description">
                        {{
                            phoneAuthEnabled
                                ? t('auth.identifierLoginHelp')
                                : t('auth.emailLoginHelp')
                        }}
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
                                phoneAuthEnabled
                                    ? t('auth.identifierPlaceholder')
                                    : t('auth.emailPlaceholder')
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
                        <a href="#" class="forgot-password" @click.prevent="showForgotPasswordStep">
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
                        <a href="#" @click.prevent="switchToRegister">{{ t('auth.register') }}</a>
                    </p>
                </template>

                <template v-else-if="loginStep === 'forgot-email'">
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
                                phoneAuthEnabled
                                    ? t('auth.identifierPlaceholder')
                                    : t('auth.emailPlaceholder')
                            "
                            autocomplete="username"
                            :class="{ 'has-error': forgotIdentifierError }"
                        />
                        <div v-if="forgotIdentifierError" class="error-message">
                            {{ forgotIdentifierError }}
                        </div>
                    </div>

                    <button
                        class="auth-button"
                        @click="handleForgotPassword"
                        :disabled="forgotLoading"
                    >
                        <span v-if="forgotLoading">{{ t('auth.sendingResetLink') }}</span>
                        <span v-else>{{ t('auth.sendResetLink') }}</span>
                    </button>

                    <p class="auth-switch">
                        <a href="#" @click.prevent="backToLoginStep">{{ t('auth.backToLogin') }}</a>
                    </p>
                </template>

                <template v-else-if="loginStep === 'forgot-phone'">
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
                        <label for="forgot-phone-password-confirm">{{
                            t('auth.confirmNewPassword')
                        }}</label>
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
                    <button
                        class="auth-button"
                        @click="handleForgotPhoneReset"
                        :disabled="forgotLoading"
                    >
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
                        <a href="#" @click.prevent="backToLoginStep">{{ t('auth.backToLogin') }}</a>
                    </p>
                </template>
            </div>
        </div>
    </div>

    <div class="modal-overlay" :class="{ show: props.showRegister }">
        <div class="modal auth-modal">
            <div class="modal-header">
                <h3>{{ t('auth.createAccount') }}</h3>
                <button
                    class="close-modal"
                    @click="closeRegisterModal"
                    :aria-label="t('auth.closeModal')"
                >
                    ×
                </button>
            </div>

            <div class="modal-content">
                <template v-if="registerStep === 'choice'">
                    <p class="auth-description">
                        {{ t('auth.registerChoiceDescription') }}
                    </p>
                    <div v-if="registerChoiceError" class="error-message form-error">
                        {{ registerChoiceError }}
                    </div>
                    <div class="auth-choice-grid">
                        <button class="auth-button" @click="registerStep = 'email'">
                            {{ t('auth.continueWithEmail') }}
                        </button>
                        <button class="auth-button secondary" @click="registerStep = 'phone-start'">
                            {{ t('auth.continueWithPhone') }}
                        </button>
                    </div>
                    <p class="auth-switch">
                        {{ t('auth.alreadyHaveAccount') }}
                        <a href="#" @click.prevent="switchToLogin">{{ t('auth.signIn') }}</a>
                    </p>
                </template>

                <template v-else-if="registerStep === 'email'">
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
                        <label for="register-password-confirm">{{
                            t('auth.confirmPassword')
                        }}</label>
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
                    <div
                        class="form-group terms-agreement"
                        :class="{ 'has-error': showAgreementError }"
                    >
                        <label class="checkbox-container">
                            <input type="checkbox" v-model="agreeToManifesto" />
                            <span class="checkmark"></span>
                            {{ t('auth.termsAgreeText') }}
                        </label>
                        <p class="error-message" v-if="showAgreementError">
                            {{ t('auth.errorTerms') }}
                        </p>
                    </div>
                    <button
                        class="auth-button"
                        @click="handleEmailRegister"
                        :disabled="isRegisterLoading"
                    >
                        <span v-if="isRegisterLoading">{{ t('auth.createAccount') }}</span>
                        <span v-else>{{ t('auth.createAccount') }}</span>
                    </button>
                    <SocialAuthButtons intercept-click @select="handleSocialAuth" />
                    <p class="auth-switch">
                        {{ t('auth.alreadyHaveAccount') }}
                        <a href="#" @click.prevent="switchToLogin">{{ t('auth.signIn') }}</a>
                    </p>
                </template>

                <template v-else-if="registerStep === 'phone-start'">
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
                        <label for="register-phone-country">{{
                            t('auth.phoneCountryOptional')
                        }}</label>
                        <input
                            id="register-phone-country"
                            v-model="registerPhoneCountry"
                            type="text"
                            maxlength="2"
                            placeholder="US"
                            autocomplete="country"
                        />
                    </div>
                    <button
                        class="auth-button"
                        @click="handlePhoneStart"
                        :disabled="isRegisterLoading"
                    >
                        <span v-if="isRegisterLoading">{{ t('auth.sendingResetLink') }}</span>
                        <span v-else>{{ t('auth.sendVerificationCode') }}</span>
                    </button>
                    <p class="auth-switch">
                        <a href="#" @click.prevent="registerStep = 'choice'">{{
                            t('auth.back')
                        }}</a>
                    </p>
                </template>

                <template v-else-if="registerStep === 'phone-confirm'">
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
                    <button
                        class="auth-button"
                        @click="handlePhoneConfirm"
                        :disabled="isRegisterLoading"
                    >
                        <span v-if="isRegisterLoading">{{ t('auth.verifyingCode') }}</span>
                        <span v-else>{{ t('auth.verifyCode') }}</span>
                    </button>
                    <p class="auth-switch">
                        <a href="#" @click.prevent="registerStep = 'phone-start'">{{
                            t('auth.back')
                        }}</a>
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
                        <label for="register-phone-password-confirm">{{
                            t('auth.confirmPassword')
                        }}</label>
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
                    <div
                        class="form-group terms-agreement"
                        :class="{ 'has-error': showAgreementError }"
                    >
                        <label class="checkbox-container">
                            <input type="checkbox" v-model="agreeToManifesto" />
                            <span class="checkmark"></span>
                            {{ t('auth.termsAgreeText') }}
                        </label>
                        <p class="error-message" v-if="showAgreementError">
                            {{ t('auth.errorTerms') }}
                        </p>
                    </div>
                    <button
                        class="auth-button"
                        @click="handlePhoneComplete"
                        :disabled="isRegisterLoading"
                    >
                        <span v-if="isRegisterLoading">{{ t('auth.createAccount') }}</span>
                        <span v-else>{{ t('auth.createAccount') }}</span>
                    </button>
                    <p class="auth-switch">
                        <a href="#" @click.prevent="registerStep = 'phone-confirm'">{{
                            t('auth.back')
                        }}</a>
                    </p>
                </template>
            </div>
        </div>
    </div>
</template>

<style scoped>
.modal-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background-color: rgba(0, 0, 0, 0.5);
    display: flex;
    justify-content: center;
    align-items: center;
    opacity: 0;
    visibility: hidden;
    transition: all 0.3s ease;
    z-index: 1000;
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    padding: 16px;
    padding-top: calc(16px + env(safe-area-inset-top, 0px));
    padding-bottom: calc(16px + env(safe-area-inset-bottom, 0px));
    overflow-y: auto;
}

.dark-theme .modal-overlay {
    background-color: rgba(0, 0, 0, 0.7);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
}

.modal-overlay.show {
    opacity: 1;
    visibility: visible;
}

.modal-overlay.show .modal {
    transform: translateY(0);
    opacity: 1;
}

.modal {
    background-color: white;
    border-radius: 16px;
    width: 100%;
    max-width: 440px;
    max-height: calc(
        100dvh - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px) - 32px
    );
    box-shadow: 0 10px 25px rgba(0, 0, 0, 0.1);
    transform: translateY(-20px);
    transition: all 0.3s ease;
    position: relative;
    display: flex;
    flex-direction: column;
    overflow: hidden;
}

.dark-theme .modal {
    background-color: #1e1e1e;
    box-shadow: 0 10px 25px rgba(0, 0, 0, 0.3);
}

.auth-modal {
    max-width: 440px;
}

.modal-header {
    padding: 16px 20px;
    border-bottom: 1px solid #eee;
    display: flex;
    justify-content: space-between;
    align-items: center;
    position: relative;
}

.dark-theme .modal-header {
    border-bottom-color: #333;
}

.modal-header h3 {
    margin: 0;
    color: var(--primary-color);
    font-size: calc(20px * var(--app-font-scale, 1));
    font-weight: 700;
}

.dark-theme .modal-header h3 {
    color: #e0e0e0;
}

.close-modal {
    background: transparent;
    border: none;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #6c757d;
    transition: all 0.2s ease;
    padding: 0;
    line-height: 1;
    width: 32px;
    height: 32px;
    border-radius: 50%;
    font-size: 22px;
    flex-shrink: 0;
}

.dark-theme .close-modal {
    color: #adb5bd;
}

.close-modal:hover {
    color: var(--primary-color);
    background-color: rgba(0, 0, 0, 0.05);
    transform: rotate(90deg);
}

.dark-theme .close-modal:hover {
    background-color: rgba(255, 255, 255, 0.1);
    color: #fff;
}

.close-modal:active {
    transform: scale(0.9) rotate(90deg);
}

.modal-content {
    padding: 16px 20px 20px;
    flex: 0 1 auto;
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
}

.auth-description {
    margin: 0 0 16px;
    color: var(--text-secondary);
    font-size: calc(14px * var(--app-font-scale, 1));
    line-height: 1.5;
}

.auth-description-centered {
    margin-top: auto;
    margin-bottom: auto;
    text-align: center;
}

.auth-choice-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
    margin: 16px 0;
}

.form-group {
    margin-bottom: 14px;
}

.form-group label {
    display: block;
    margin-bottom: 6px;
    font-weight: 500;
    font-size: calc(13px * var(--app-font-scale, 1));
    color: var(--text-color);
}

.dark-theme .form-group label {
    color: #e0e0e0;
}

input[type='email'],
input[type='password'],
input[type='text'],
input[type='tel'] {
    width: 100%;
    padding: 10px 12px;
    border: 1px solid var(--border-color, #ddd);
    border-radius: 8px;
    font-size: calc(14px * var(--app-font-scale, 1));
    transition: all 0.2s ease;
    background-color: white;
    color: var(--text-color);
    outline: none;
    box-sizing: border-box;
    background-repeat: no-repeat;
    background-position: 12px center;
    background-size: 18px 18px;
}

input[type='email'],
#login-identifier {
    padding-left: 40px;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%236c757d' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z'/%3E%3Cpolyline points='22,6 12,13 2,6'/%3E%3C/svg%3E");
}

input[type='password'] {
    padding-left: 40px;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%236c757d' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='3' y='11' width='18' height='11' rx='2' ry='2'/%3E%3Cpath d='M7 11V7a5 5 0 0 1 10 0v4'/%3E%3C/svg%3E");
}

input[type='tel'] {
    padding-left: 40px;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%236c757d' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z'/%3E%3C/svg%3E");
}

input[id$='-name'] {
    padding-left: 40px;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%236c757d' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2'/%3E%3Ccircle cx='12' cy='7' r='4'/%3E%3C/svg%3E");
}

input[type='email']:focus,
input[type='password']:focus,
input[type='text']:focus,
input[type='tel']:focus {
    border-color: var(--primary-color);
    box-shadow: 0 0 0 2px rgba(78, 127, 168, 0.2);
}

.dark-theme input[type='email'],
.dark-theme input[type='password'],
.dark-theme input[type='text'],
.dark-theme input[type='tel'] {
    background-color: #2a2a2a;
    border-color: #444;
    color: #e0e0e0;
}

.dark-theme input:-webkit-autofill,
.dark-theme input:-webkit-autofill:hover,
.dark-theme input:-webkit-autofill:focus,
.dark-theme input:-webkit-autofill:active {
    -webkit-box-shadow: 0 0 0 30px #2a2a2a inset !important;
    -webkit-text-fill-color: #e0e0e0 !important;
    caret-color: #e0e0e0;
    transition: background-color 5000s ease-in-out 0s;
}

input:-webkit-autofill,
input:-webkit-autofill:hover,
input:-webkit-autofill:focus,
input:-webkit-autofill:active {
    transition: background-color 5000s ease-in-out 0s;
}

.error-message {
    color: #dc3545;
    font-size: calc(13px * var(--app-font-scale, 1));
    margin-top: 6px;
    margin-bottom: 0;
}

.form-error {
    background-color: rgba(220, 53, 69, 0.1);
    color: #dc3545;
    padding: 12px;
    border-radius: 8px;
    margin-bottom: 16px;
    font-size: calc(14px * var(--app-font-scale, 1));
    font-weight: 500;
}

.dark-theme .form-error {
    background-color: rgba(220, 53, 69, 0.2);
    color: #ff6b6b;
}

.form-options {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 16px;
    gap: 12px;
    flex-wrap: wrap;
}

.checkbox-container {
    display: flex;
    align-items: center;
    position: relative;
    padding-left: 30px;
    cursor: pointer;
    font-size: calc(14px * var(--app-font-scale, 1));
    color: var(--text-color);
    user-select: none;
    line-height: 20px;
    min-height: 20px;
}

.checkbox-container input {
    position: absolute;
    opacity: 0;
    cursor: pointer;
    height: 0;
    width: 0;
}

.checkmark {
    position: absolute;
    top: 0;
    left: 0;
    height: 20px;
    width: 20px;
    background-color: #f8f9fa;
    border: 1px solid var(--border-color, #ddd);
    border-radius: 4px;
    box-sizing: border-box;
}

.dark-theme .checkmark {
    background-color: #2a2a2a;
    border-color: #444;
}

.checkbox-container:hover input ~ .checkmark {
    background-color: #e9ecef;
}

.checkbox-container input:checked ~ .checkmark {
    background-color: var(--primary-color);
    border-color: var(--primary-color);
}

.checkmark:after {
    content: '';
    position: absolute;
    display: none;
}

.checkbox-container input:checked ~ .checkmark:after {
    display: block;
}

.checkbox-container .checkmark:after {
    left: 7px;
    top: 3px;
    width: 5px;
    height: 10px;
    border: solid white;
    border-width: 0 2px 2px 0;
    transform: rotate(45deg);
}

.forgot-password {
    color: var(--primary-color);
    font-size: calc(14px * var(--app-font-scale, 1));
    text-decoration: none;
    transition: all 0.2s ease;
}

.forgot-password:hover {
    text-decoration: underline;
    color: var(--accent-color);
}

.terms-agreement {
    margin-bottom: 16px;
}

.terms-agreement.has-error .checkbox-container {
    color: var(--danger-color, #b83232);
}

.terms-agreement.has-error .checkmark {
    border-color: var(--danger-color, #b83232);
}

.auth-button {
    width: 100%;
    padding: 11px 14px;
    background-color: var(--primary-color);
    color: white;
    border: none;
    border-radius: 10px;
    cursor: pointer;
    font-size: calc(15px * var(--app-font-scale, 1));
    font-weight: 500;
    transition: all 0.15s cubic-bezier(0.4, 0, 0.2, 1);
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
    display: flex;
    align-items: center;
    justify-content: center;
    line-height: 1.2;
}

.auth-button:hover {
    background-color: var(--accent-color);
    transform: translateY(-2px);
    box-shadow: 0 6px 16px rgba(0, 0, 0, 0.15);
}

.auth-button:active {
    transform: translateY(1px) scale(0.98);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
}

.auth-button:disabled {
    opacity: 0.6;
    cursor: not-allowed;
    transform: none;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
}

.auth-button:disabled:hover {
    transform: none;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
}

.auth-button.secondary {
    background-color: var(--secondary-color, #6b7280);
}

.auth-button.secondary:hover {
    background-color: var(--secondary-hover-color, #4b5563);
}

.auth-switch {
    margin-top: 14px;
    text-align: center;
    color: var(--text-secondary, #6c757d);
    font-size: calc(13px * var(--app-font-scale, 1));
}

.auth-switch a {
    color: var(--primary-color);
    text-decoration: none;
    font-weight: 500;
    transition: all 0.2s ease;
    cursor: pointer;
}

.auth-switch a:hover {
    color: var(--accent-color);
    text-decoration: underline;
}

.callout {
    border-radius: 12px;
    padding: 12px 16px;
    margin-bottom: 16px;
    font-size: 14px;
    line-height: 1.5;
}

.callout--info {
    background: rgba(78, 127, 168, 0.1);
    color: var(--text-color);
}

@media (max-width: 768px) {
    .modal {
        max-width: 100%;
        border-radius: 16px;
        min-height: auto;
    }

    .modal-header {
        padding: 14px 16px;
    }

    .modal-header h3 {
        font-size: calc(18px * var(--app-font-scale, 1));
    }

    .modal-content {
        padding: 14px 16px 18px;
    }

    .form-group {
        margin-bottom: 14px;
    }

    .auth-button {
        padding: 12px;
        font-size: calc(15px * var(--app-font-scale, 1));
    }

    .auth-switch {
        margin-top: 16px;
        font-size: calc(13px * var(--app-font-scale, 1));
    }
}

@media (max-width: 640px) {
    .auth-choice-grid {
        grid-template-columns: 1fr;
    }
}
</style>
