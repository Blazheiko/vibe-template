<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import AuthModalShell from './auth/AuthModalShell.vue'
import ForgotPasswordFlow from './auth/ForgotPasswordFlow.vue'
import LoginForm from './auth/LoginForm.vue'
import RegisterEmailForm from './auth/RegisterEmailForm.vue'
import RegisterPhoneFlow from './auth/RegisterPhoneFlow.vue'
import { isPhoneAuthEnabled } from '@/utils/phone-auth'

// The two auth modals (sign in, create an account) and what is shared between their steps. Each
// step is a component of its own in ./auth; this one decides which is shown, keeps what must
// survive a change of step (the typed identifier and password), and starts a step afresh when
// a modal is opened, closed or switched.
const { t } = useI18n()

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

type ForgotStep = 'email' | 'phone' | 'sent'
type RegisterMode = 'choice' | 'email' | 'phone'

const firstRegisterMode = (): RegisterMode => (isPhoneAuthEnabled() ? 'choice' : 'email')

const loginView = ref<'login' | 'forgot'>('login')
const forgotStep = ref<ForgotStep>('email')
const loginIdentifier = ref('')
const loginPassword = ref('')
const loginNotice = ref('')
// What the forgot-password step starts from: the identifier as it was typed when it was opened.
const forgotStart = ref('')
// Bumped to throw away what a step holds: a changed key mounts the step again, empty.
const loginEpoch = ref(0)
const registerEpoch = ref(0)

const registerMode = ref<RegisterMode>(firstRegisterMode())

const loginTitle = computed(() => {
    if (loginView.value === 'login') return t('auth.signIn')
    if (forgotStep.value === 'phone') return t('auth.phoneRecoveryTitle')
    if (forgotStep.value === 'sent') return t('auth.resetLinkSent')
    return t('auth.resetPasswordTitle')
})

function clearLoginState(): void {
    loginView.value = 'login'
    forgotStep.value = 'email'
    loginIdentifier.value = ''
    loginPassword.value = ''
    loginNotice.value = ''
    forgotStart.value = ''
    loginEpoch.value += 1
}

function clearRegisterState(): void {
    registerMode.value = firstRegisterMode()
    registerEpoch.value += 1
}

function closeLoginModal(): void {
    clearLoginState()
    emit('close')
}

function closeRegisterModal(): void {
    clearRegisterState()
    emit('close')
}

function switchToRegister(): void {
    clearLoginState()
    clearRegisterState()
    emit('show-register')
}

function switchToLogin(): void {
    clearRegisterState()
    emit('show-login')
}

function showForgotPasswordStep(): void {
    forgotStart.value = loginIdentifier.value.trim()
    forgotStep.value = 'email'
    loginView.value = 'forgot'
}

function backToLoginStep(): void {
    loginNotice.value = ''
    loginView.value = 'login'
}

// The password was set by SMS code: back to sign-in with a note, and nothing typed there.
function onPhonePasswordReset(): void {
    loginIdentifier.value = ''
    loginPassword.value = ''
    loginNotice.value = t('auth.phoneRecoveryResetSuccess')
    loginView.value = 'login'
}

// The same two announcements, in the same order, whichever form signed the user in.
function finishSignIn(): void {
    emit('close')
    emit('auth-success')
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
    <AuthModalShell :show="props.showLogin" :title="loginTitle" @close="closeLoginModal">
        <LoginForm
            v-if="loginView === 'login'"
            :key="loginEpoch"
            v-model:identifier="loginIdentifier"
            v-model:password="loginPassword"
            :token="props.token"
            :notice="loginNotice"
            @forgot="showForgotPasswordStep"
            @register="switchToRegister"
            @signed-in="finishSignIn"
        />
        <ForgotPasswordFlow
            v-else
            :key="loginEpoch"
            v-model:step="forgotStep"
            :identifier="forgotStart"
            @back="backToLoginStep"
            @reset-success="onPhonePasswordReset"
        />
    </AuthModalShell>

    <AuthModalShell
        :show="props.showRegister"
        :title="t('auth.createAccount')"
        @close="closeRegisterModal"
    >
        <template v-if="registerMode === 'choice'">
            <p class="auth-description">
                {{ t('auth.registerChoiceDescription') }}
            </p>
            <div class="auth-choice-grid">
                <button class="auth-button" @click="registerMode = 'email'">
                    {{ t('auth.continueWithEmail') }}
                </button>
                <button class="auth-button secondary" @click="registerMode = 'phone'">
                    {{ t('auth.continueWithPhone') }}
                </button>
            </div>
            <p class="auth-switch">
                {{ t('auth.alreadyHaveAccount') }}
                <a href="#" @click.prevent="switchToLogin">{{ t('auth.signIn') }}</a>
            </p>
        </template>

        <RegisterEmailForm
            v-else-if="registerMode === 'email'"
            :key="registerEpoch"
            :token="props.token"
            @login="switchToLogin"
            @signed-in="finishSignIn"
        />

        <RegisterPhoneFlow
            v-else
            :key="registerEpoch"
            :token="props.token"
            @back="registerMode = 'choice'"
            @signed-in="finishSignIn"
        />
    </AuthModalShell>
</template>

<style src="../assets/auth-forms.css"></style>
