<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { MfaVerifyInput } from 'shared/schemas'
import type { SignedInUser } from '@/composables/useCompleteSignIn'
import { usePasskey } from '@/composables/usePasskeys'
import { useUserStore } from '@/stores/user'
import { authApi } from '@/utils/api'
import { getErrorReason } from '@/utils/response-normalizer'

// feat-245 (docs/plan/passkeys-mfa-plan.md, Р4, Р15): the second sign-in step. The ticket is an
// HttpOnly cookie the password (or OAuth) answer set; this form sends a TOTP code, a recovery
// code or (feat-246) a passkey signature. A 503 `mfa_completion_pending` means the server
// confirmed the sign-in and is finishing it: the SAME request is sent again after a pause, and,
// when the pauses run out, by the "Try again" button, until the server gives a final answer. A
// passkey answer is not replaced by a new ceremony meanwhile: the server finishes the one it
// confirmed. A 401 `mfa_attempt_expired` to a passkey answer (its challenge lapsed or was spent
// by an attempt that rolled back) asks for a new ceremony; nothing was counted. When the options
// answer `mfa_completion_pending` (the answer of a confirmed passkey was lost, or the page was
// reloaded), the form keeps no request to repeat: it sends `{ method: 'continue' }`, which only
// finishes what this browser's ticket confirmed, with the same pauses. While a completion is
// pending the other factors are hidden: the retry sends the kept request, not a new one. Mounted
// after a reload for a ticket that is finishing (`completing`, from POST /auth/mfa/state), the
// form sends `continue` at once. A recovery sign-in's answer carries the recovery state (Р8): it
// goes to the store before the account page opens, so that page never asks what a recovery
// session is refused.
type Method = 'webauthn' | 'totp' | 'recovery_code'
const props = withDefaults(defineProps<{ methods: Method[]; completing?: boolean }>(), {
    completing: false,
})
const emit = defineEmits<{ 'signed-in': [user: SignedInUser]; restart: [message: string] }>()

const { t } = useI18n()
const userStore = useUserStore()
const usable = computed(() =>
    (['webauthn', 'totp', 'recovery_code'] as const).filter((m) => props.methods.includes(m)),
)
const method = ref<Method>(usable.value[0] ?? 'recovery_code')
const code = ref('')
const error = ref('')
const busy = ref(false)
/** The request the server is finishing: a retry sends exactly this one. */
const pendingBody = ref<MfaVerifyInput | null>(null)

const PENDING_RETRIES = 5
const PENDING_DELAY_MS = 1000
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const FINAL_REASONS = new Set([
    'invalid_code',
    'mfa_attempt_expired',
    'mfa_ticket_used',
    'mfa_ticket_invalid',
    'session_revoked',
])

const choose = (next: Method): void => {
    method.value = next
    code.value = ''
    error.value = ''
}

/** The other ways this account offers, as links under the form; none while one is finishing. */
const alternatives = computed(() =>
    pendingBody.value !== null ? [] : usable.value.filter((m) => m !== method.value),
)

async function send(body: MfaVerifyInput): Promise<void> {
    for (let attempt = 0; attempt <= PENDING_RETRIES; attempt++) {
        const { data } = await authApi.mfaVerify(body)
        if (data?.status === 'success' && data.user !== undefined) {
            pendingBody.value = null
            // Before the navigation: main/init says the same, but after the page mounted.
            userStore.setRecovery(data.recovery ?? null)
            emit('signed-in', data.user)
            return
        }
        const reason = getErrorReason(data) ?? ''
        if (reason === 'mfa_completion_pending') {
            pendingBody.value = body
            if (attempt < PENDING_RETRIES) {
                await wait(PENDING_DELAY_MS)
                continue
            }
            error.value = t('loginMfa.errorPending')
            return
        }
        // A final answer ends the pending request; any other failure (the network, a 503
        // without a reason) keeps it, so the retry still continues the confirmed attempt.
        if (FINAL_REASONS.has(reason)) pendingBody.value = null
        if (reason === 'mfa_ticket_invalid' || reason === 'session_revoked') {
            emit('restart', t('loginMfa.errorRestart'))
            return
        }
        // `continue` carries no proof: the factor in view is the one asked for again.
        const passkey =
            body.method === 'webauthn' ||
            (body.method === 'continue' && method.value === 'webauthn')
        error.value =
            reason === 'invalid_code'
                ? passkey
                    ? t('loginMfa.errorPasskey')
                    : t('loginMfa.errorCode')
                : reason === 'mfa_attempt_expired'
                  ? passkey
                      ? t('loginMfa.errorPasskeyRetry')
                      : t('loginMfa.errorRetry')
                  : reason === 'mfa_ticket_used'
                    ? t('loginMfa.errorUsed')
                    : pendingBody.value !== null
                      ? t('loginMfa.errorPending')
                      : t('auth.errorServer')
        return
    }
}

async function submit(): Promise<void> {
    if (busy.value) return
    const pending = pendingBody.value
    if (pending !== null) {
        // "Try again" continues the request the server is finishing, whatever is selected.
        busy.value = true
        error.value = ''
        try {
            await send(pending)
        } finally {
            busy.value = false
        }
        return
    }
    if (method.value === 'webauthn') {
        await withPasskey()
        return
    }
    if (code.value.trim() === '') return
    busy.value = true
    error.value = ''
    try {
        await send({ method: method.value, code: code.value.trim() })
    } finally {
        busy.value = false
    }
}

/** After a reload: a confirmed attempt is finishing and nothing is kept to repeat. */
onMounted(async () => {
    if (!props.completing) return
    busy.value = true
    try {
        await send({ method: 'continue' })
    } finally {
        busy.value = false
    }
})

/** feat-246: the options of the ticket, the passkey dialog, then the same verify request. */
async function withPasskey(): Promise<void> {
    busy.value = true
    error.value = ''
    try {
        const { data } = await authApi.mfaWebauthnOptions()
        if (data?.status !== 'success') {
            const reason = getErrorReason(data) ?? ''
            if (reason === 'mfa_ticket_invalid') emit('restart', t('loginMfa.errorRestart'))
            // A confirmed attempt is finishing and this form lost its request: continue it.
            else if (reason === 'mfa_completion_pending') await send({ method: 'continue' })
            else error.value = t('auth.errorServer')
            return
        }
        const signed = await usePasskey(data.options)
        if (!signed.ok) {
            error.value =
                signed.failure === 'cancelled'
                    ? t('loginMfa.passkeyCancelled')
                    : t('loginMfa.errorPasskey')
            return
        }
        await send({ method: 'webauthn', response: signed.value })
    } finally {
        busy.value = false
    }
}
</script>

<template>
    <form class="mfa-form" data-testid="mfa-challenge" @submit.prevent="submit">
        <p class="auth-description">
            {{
                method === 'webauthn'
                    ? t('loginMfa.passkeyHelp')
                    : method === 'totp'
                      ? t('loginMfa.totpHelp')
                      : t('loginMfa.recoveryHelp')
            }}
        </p>
        <div v-if="error" class="error-message form-error" role="alert">{{ error }}</div>
        <div v-if="method !== 'webauthn'" class="form-group">
            <label for="mfa-code">
                {{ method === 'totp' ? t('loginMfa.totpLabel') : t('loginMfa.recoveryLabel') }}
            </label>
            <input
                id="mfa-code"
                v-model="code"
                :inputmode="method === 'totp' ? 'numeric' : 'text'"
                autocomplete="one-time-code"
                :maxlength="method === 'totp' ? 10 : 64"
                data-testid="mfa-code"
                required
            />
        </div>
        <button class="auth-button" type="submit" :disabled="busy" data-testid="mfa-submit">
            {{
                busy
                    ? t('auth.signingIn')
                    : pendingBody !== null
                      ? t('loginMfa.retryPending')
                      : method === 'webauthn'
                        ? t('loginMfa.usePasskeyButton')
                        : t('loginMfa.submit')
            }}
        </button>
        <p v-for="other in alternatives" :key="other" class="auth-switch">
            <a
                href="#"
                :data-testid="
                    other === 'recovery_code'
                        ? 'mfa-use-recovery'
                        : other === 'totp'
                          ? 'mfa-use-totp'
                          : 'mfa-use-passkey'
                "
                @click.prevent="choose(other)"
            >
                {{
                    other === 'recovery_code'
                        ? t('loginMfa.useRecovery')
                        : other === 'totp'
                          ? t('loginMfa.useTotp')
                          : t('loginMfa.usePasskey')
                }}
            </a>
        </p>
        <p class="auth-description">{{ t('loginMfa.noAccess') }}</p>
    </form>
</template>
