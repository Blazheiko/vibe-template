<script setup lang="ts">
import { computed, ref } from 'vue'
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
// confirmed the sign-in and is finishing it: the same request is sent again after a pause.
type Method = 'webauthn' | 'totp' | 'recovery_code'
const props = defineProps<{ methods: Method[] }>()
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

const PENDING_RETRIES = 5
const PENDING_DELAY_MS = 1000
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const choose = (next: Method): void => {
    method.value = next
    code.value = ''
    error.value = ''
}

/** The other ways this account offers, as links under the form. */
const alternatives = computed(() => usable.value.filter((m) => m !== method.value))

async function send(body: MfaVerifyInput): Promise<void> {
    for (let attempt = 0; attempt <= PENDING_RETRIES; attempt++) {
        const { data } = await authApi.mfaVerify(body)
        if (data?.status === 'success' && data.user !== undefined) {
            emit('signed-in', data.user)
            // A recovery code opens a recovery session (Р8). main/init says so too, but it
            // answers after the account page mounted; until then the page must not ask the
            // routes a recovery session is refused.
            if (body.method === 'recovery_code') {
                userStore.setRecovery({ expiresAt: '', replaced: false })
            }
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
                ? body.method === 'webauthn'
                    ? t('loginMfa.errorPasskey')
                    : t('loginMfa.errorCode')
                : reason === 'mfa_attempt_expired'
                  ? t('loginMfa.errorRetry')
                  : reason === 'mfa_ticket_used'
                    ? t('loginMfa.errorUsed')
                    : t('auth.errorServer')
        return
    }
}

async function submit(): Promise<void> {
    if (busy.value) return
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

/** feat-246: the options of the ticket, the passkey dialog, then the same verify request. */
async function withPasskey(): Promise<void> {
    busy.value = true
    error.value = ''
    try {
        const { data } = await authApi.mfaWebauthnOptions()
        if (data?.status !== 'success') {
            const reason = getErrorReason(data) ?? ''
            if (reason === 'mfa_ticket_invalid') emit('restart', t('loginMfa.errorRestart'))
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
