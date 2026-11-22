<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { SignedInUser } from '@/composables/useCompleteSignIn'
import { authApi } from '@/utils/api'
import { getErrorReason } from '@/utils/response-normalizer'

// feat-245 (docs/plan/passkeys-mfa-plan.md, Р4, Р15): the second sign-in step. The ticket is an
// HttpOnly cookie the password (or OAuth) answer set; this form sends a TOTP code or a recovery
// code. A 503 `mfa_completion_pending` means the server confirmed the sign-in and is finishing
// it: the same request is sent again after a pause.
const props = defineProps<{ methods: ('totp' | 'recovery_code' | 'webauthn')[] }>()
const emit = defineEmits<{ 'signed-in': [user: SignedInUser]; restart: [message: string] }>()

const { t } = useI18n()
const usable = computed(() =>
    props.methods.filter(
        (m): m is 'totp' | 'recovery_code' => m === 'totp' || m === 'recovery_code',
    ),
)
const method = ref<'totp' | 'recovery_code'>(usable.value[0] ?? 'recovery_code')
const code = ref('')
const error = ref('')
const busy = ref(false)

const PENDING_RETRIES = 5
const PENDING_DELAY_MS = 1000
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function submit(): Promise<void> {
    if (busy.value || code.value.trim() === '') return
    busy.value = true
    error.value = ''
    try {
        const body = { method: method.value, code: code.value.trim() }
        for (let attempt = 0; attempt <= PENDING_RETRIES; attempt++) {
            const { data } = await authApi.mfaVerify(body)
            if (data?.status === 'success' && data.user !== undefined) {
                emit('signed-in', data.user)
                return
            }
            const reason = getErrorReason(data) ?? ''
            if (reason === 'mfa_completion_pending' && attempt < PENDING_RETRIES) {
                await wait(PENDING_DELAY_MS)
                continue
            }
            if (reason === 'mfa_ticket_invalid' || reason === 'session_revoked') {
                emit('restart', t('loginMfa.errorRestart'))
                return
            }
            error.value =
                reason === 'invalid_code'
                    ? t('loginMfa.errorCode')
                    : reason === 'mfa_attempt_expired'
                      ? t('loginMfa.errorRetry')
                      : reason === 'mfa_ticket_used'
                        ? t('loginMfa.errorUsed')
                        : t('auth.errorServer')
            return
        }
    } finally {
        busy.value = false
    }
}
</script>

<template>
    <form class="mfa-form" data-testid="mfa-challenge" @submit.prevent="submit">
        <p class="auth-description">
            {{ method === 'totp' ? t('loginMfa.totpHelp') : t('loginMfa.recoveryHelp') }}
        </p>
        <div v-if="error" class="error-message form-error" role="alert">{{ error }}</div>
        <div class="form-group">
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
            {{ busy ? t('auth.signingIn') : t('loginMfa.submit') }}
        </button>
        <p class="auth-switch">
            <a
                v-if="method === 'totp'"
                href="#"
                data-testid="mfa-use-recovery"
                @click.prevent="((method = 'recovery_code'), (code = ''), (error = ''))"
            >
                {{ t('loginMfa.useRecovery') }}
            </a>
            <a
                v-else-if="usable.includes('totp')"
                href="#"
                data-testid="mfa-use-totp"
                @click.prevent="((method = 'totp'), (code = ''), (error = ''))"
            >
                {{ t('loginMfa.useTotp') }}
            </a>
        </p>
        <p class="auth-description">{{ t('loginMfa.noAccess') }}</p>
    </form>
</template>
