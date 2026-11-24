<script lang="ts">
// A ticket can only be left over from an earlier page: the second step of a sign-in started on this
// page lives in memory. So the sign-in page asks the server only when this page load opened the
// sign-in page itself (a reload, a new tab), once — not when the app navigates here after a
// sign-out, where there is no ticket and the stale session's request would only disturb the page.
let pageLoadPath = typeof window === 'undefined' ? '' : window.location.pathname
let askedThisPageLoad = false
export function consumePageLoadAsk(): boolean {
    if (askedThisPageLoad || !pageLoadPath.endsWith('/login')) return false
    askedThisPageLoad = true
    return true
}
/** Test seam: a new page load that opened `path`. */
export function resetPageLoadAsk(path = '/login'): void {
    pageLoadPath = path
    askedThisPageLoad = false
}
</script>

<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ErrorCode } from 'shared/errors'
import { authApi } from '@/utils/api'
import { getResponseMessage, hasResponseError } from '@/utils/response-normalizer'
import { isEmail, looksLikeIdentifierPhone } from '@/utils/auth-identifiers'
import { isPhoneAuthEnabled } from '@/utils/phone-auth'
import { passwordLengthProblem } from '@/utils/validate-password'
import { useAuthRequest } from '@/composables/useAuthRequest'
import { useCompleteSignIn } from '@/composables/useCompleteSignIn'
import { passkeyAutofillSupported, passkeysSupported, usePasskey } from '@/composables/usePasskeys'
import SocialAuthButtons from '../SocialAuthButtons.vue'
import MfaChallengeForm from './MfaChallengeForm.vue'
import { useRoute } from 'vue-router'

// The sign-in step of the login modal. The typed identifier and password belong to the modal (the
// forgot-password step starts from the identifier and coming back must not lose either), the rest
// is this form's.
const props = withDefaults(
    defineProps<{
        /** A message to show at first, such as "password updated, sign in with the new one". */
        notice: string
        /** The modal is shown (both modals stay mounted): only then the second step is asked. */
        active?: boolean
    }>(),
    { active: true },
)

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

// feat-245 (Р4): the password (or an OAuth sign-in, back on /login?mfa=required) was right and
// the account has a second factor: the second step replaces the password form. feat-246: the
// OAuth return names the methods of the account (`&methods=webauthn,totp,recovery_code`).
type SecondStepMethod = 'totp' | 'recovery_code' | 'webauthn'
const SECOND_STEP_METHODS: readonly SecondStepMethod[] = ['webauthn', 'totp', 'recovery_code']
const route = useRoute()
const methodsOfQuery = (): SecondStepMethod[] => {
    const raw = typeof route.query.methods === 'string' ? route.query.methods.split(',') : []
    const methods = SECOND_STEP_METHODS.filter((method) => raw.includes(method))
    return methods.length > 0 ? methods : ['totp', 'recovery_code']
}
/**
 * The second step shown from the query of an OAuth return, not by a sign-in on this page; false
 * once this page restarts the sign-in or opens a second step of its own.
 */
let secondStepFromQuery = route.query.mfa === 'required'
const secondStep = ref<SecondStepMethod[] | null>(secondStepFromQuery ? methodsOfQuery() : null)
/** The ticket is finishing a confirmed attempt: the form continues it at once. */
const secondStepCompleting = ref(false)
const restartSignIn = (message: string): void => {
    secondStep.value = null
    secondStepFromQuery = false
    secondStepCompleting.value = false
    loginError.value = message
}

// Р4: the second step of a password sign-in lives only in memory. After a reload the ticket cookie
// may still be there: ask before a new sign-in, so the password is not typed again (a new ticket)
// and a confirmed attempt is finished by `continue`. Only `mfa_required` changes the form; any
// other answer (none, an error, no network) leaves the password form.
let secondStepAsked = false
/**
 * A sign-in started (or its second step shown) while the answer was on its way wins. feat-257
 * (docs/plan/mfa-review-fixes-7-plan.md, item 2): a second step shown from the query of an OAuth
 * return is no sign-in of this page: after a reload (or the reload of `account_changed`) the ticket
 * may be finishing, and the answer tells the form to continue it.
 */
const signInUnderway = (): boolean =>
    (secondStep.value !== null && !secondStepFromQuery) || isLoginLoading.value
async function restoreSecondStep(): Promise<void> {
    if (secondStepAsked || signInUnderway() || !consumePageLoadAsk()) return
    secondStepAsked = true
    const { data } = await authApi.mfaState()
    if (data?.status !== 'mfa_required' || signInUnderway()) return
    secondStepCompleting.value = data.completing === true
    secondStep.value = data.methods
}
watch(
    () => props.active,
    (active) => {
        if (active) void restoreSecondStep()
    },
    { immediate: true },
)

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

// feat-246 (Р6): a sign-in with a passkey alone, by the button or from the suggestions of the
// identifier field (conditional UI). Only one ceremony runs at a time: the button replaces the
// waiting autofill one (the library aborts it).
const passkeyAvailable = ref(false)

async function passkeySignIn(autofill: boolean): Promise<void> {
    const { data } = await authApi.passkeyOptions()
    if (data?.status !== 'success') {
        if (!autofill) loginError.value = t('auth.errorServer')
        return
    }
    const signed = await usePasskey(data.options, autofill)
    if (!signed.ok) {
        if (!autofill && signed.failure !== 'cancelled') loginError.value = t('auth.passkeyFailed')
        return
    }
    await runAuthRequest(isLoginLoading, loginError, 'Passkey sign-in', async () => {
        const verified = await authApi.passkeyVerify({
            challengeId: data.challengeId,
            response: signed.value,
        })
        if (verified.data?.status === 'success' && verified.data.user !== undefined) {
            completeSignIn(verified.data.user)
            return
        }
        loginError.value = t('auth.passkeyFailed')
    })
}

function handlePasskeyButton(): void {
    loginError.value = ''
    void passkeySignIn(false)
}

// The autofill request starts when the user acts in the identifier field (a pointer or a key),
// once per visit; the modal's own focus does not start it, so a page that only passes through
// /login (a redirect after a sign-out) holds no pending ceremony. The button needs none.
let autofillStarted = false
async function startAutofill(): Promise<void> {
    if (autofillStarted || secondStep.value !== null) return
    autofillStarted = true
    if (await passkeyAutofillSupported()) await passkeySignIn(true)
}

onMounted(async () => {
    passkeyAvailable.value = await passkeysSupported()
})

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

        if (data?.status === 'mfa_required') {
            loginPassword.value = ''
            secondStepFromQuery = false
            secondStep.value = data.methods
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
    <MfaChallengeForm
        v-if="secondStep !== null"
        :methods="secondStep"
        :completing="secondStepCompleting"
        @signed-in="completeSignIn"
        @restart="restartSignIn"
    />
    <template v-else>
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
                autocomplete="username webauthn"
                @pointerdown="startAutofill"
                @keydown="startAutofill"
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

        <button
            v-if="passkeyAvailable"
            class="auth-button secondary"
            type="button"
            data-testid="passkey-sign-in"
            :disabled="isLoginLoading"
            @click="handlePasskeyButton"
        >
            {{ t('auth.signInWithPasskey') }}
        </button>

        <SocialAuthButtons />

        <p class="auth-switch">
            {{ t('auth.noAccount') }}
            <a href="#" @click.prevent="emit('register')">{{ t('auth.register') }}</a>
        </p>
    </template>
</template>
