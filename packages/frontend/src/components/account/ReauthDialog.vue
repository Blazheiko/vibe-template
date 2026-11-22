<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useModalDialog } from '@/composables/useModalDialog'
import { usePasskey } from '@/composables/usePasskeys'
import { reauthState, type ReauthProof } from '@/composables/useReauth'
import { authApi } from '@/utils/api'
import { getErrorReason } from '@/utils/response-normalizer'

// feat-245 (docs/plan/passkeys-mfa-plan.md, Р15): the one dialog that confirms it is the user
// before a sensitive action. It shows only the proofs the server listed for this account and
// action (no password field when the password is not one of them).
const { t } = useI18n()

const panel = ref<HTMLElement | null>(null)
const titleId = useId()
const proof = ref<ReauthProof | null>(null)
const password = ref('')
const code = ref('')
const error = ref('')
const busy = ref(false)

// feat-246: a passkey is offered first when the server lists it.
const usable = computed(() =>
    (['webauthn', 'totp', 'password'] as const).filter((p) => reauthState.proofs.includes(p)),
)

watch(
    () => reauthState.open,
    (open) => {
        if (!open) return
        proof.value = usable.value[0] ?? null
        password.value = ''
        code.value = ''
        error.value = ''
    },
)

const cancel = (): void => {
    reauthState.resolve?.(false)
}

useModalDialog({ panel, isOpen: () => reauthState.open, close: cancel })

const ERRORS = new Map<string, string>([
    ['current_password_incorrect', 'account.reauth.errorPassword'],
    ['current_password_required', 'account.reauth.errorPassword'],
    ['invalid_code', 'account.reauth.errorCode'],
])

/** feat-246: the options of this session, the passkey dialog, then the step-up request. */
async function passkeyProof(): Promise<ReturnType<typeof authApi.reauth> | null> {
    const options = await authApi.reauthWebauthnOptions()
    if (options.data?.status !== 'success') return null
    const signed = await usePasskey(options.data.options)
    if (!signed.ok) {
        error.value =
            signed.failure === 'cancelled'
                ? t('account.reauth.passkeyCancelled')
                : t('account.reauth.errorPasskey')
        return null
    }
    return authApi.reauth({ proof: 'webauthn', response: signed.value })
}

async function submit(): Promise<void> {
    if (proof.value === null || busy.value) return
    busy.value = true
    error.value = ''
    try {
        const answer =
            proof.value === 'webauthn'
                ? await passkeyProof()
                : await authApi.reauth(
                      proof.value === 'password'
                          ? { proof: 'password', password: password.value }
                          : { proof: 'totp', code: code.value.replace(/\s/g, '') },
                  )
        if (answer === null) {
            if (error.value === '') error.value = t('account.reauth.errorGeneric')
            return
        }
        const { data, error: transport } = answer
        if (transport === null && data?.status === 'success') {
            reauthState.resolve?.(true)
            return
        }
        const known = ERRORS.get(getErrorReason(data) ?? '')
        error.value =
            transport?.transportCode === 429
                ? t('account.reauth.errorTooMany')
                : t(known ?? 'account.reauth.errorGeneric')
    } finally {
        busy.value = false
    }
}
</script>

<template>
    <div v-if="reauthState.open" class="reauth-overlay" @click.self="cancel">
        <form
            ref="panel"
            class="reauth-panel"
            role="dialog"
            aria-modal="true"
            :aria-labelledby="titleId"
            tabindex="-1"
            data-testid="reauth-dialog"
            @submit.prevent="submit"
        >
            <h3 :id="titleId">{{ t('account.reauth.title') }}</h3>
            <p>{{ t('account.reauth.text') }}</p>

            <div v-if="usable.length > 1" class="reauth-switch" role="tablist">
                <button
                    v-for="option in usable"
                    :key="option"
                    type="button"
                    role="tab"
                    :aria-selected="proof === option"
                    :data-testid="`reauth-proof-${option}`"
                    @click="proof = option"
                >
                    {{ t(`account.reauth.proof.${option}`) }}
                </button>
            </div>

            <label v-if="proof === 'password'" class="reauth-field">
                <span>{{ t('account.reauth.password') }}</span>
                <input
                    v-model="password"
                    type="password"
                    autocomplete="current-password"
                    data-modal-initial-focus
                    data-testid="reauth-password"
                    required
                />
            </label>
            <label v-else-if="proof === 'totp'" class="reauth-field">
                <span>{{ t('account.reauth.code') }}</span>
                <input
                    v-model="code"
                    inputmode="numeric"
                    autocomplete="one-time-code"
                    maxlength="10"
                    data-modal-initial-focus
                    data-testid="reauth-code"
                    required
                />
            </label>
            <p v-else-if="proof === 'webauthn'" class="reauth-hint" data-testid="reauth-passkey">
                {{ t('account.reauth.passkeyHint') }}
            </p>
            <p v-else class="reauth-error">{{ t('account.reauth.noProof') }}</p>

            <p v-if="error !== ''" class="reauth-error" role="alert" data-testid="reauth-error">
                {{ error }}
            </p>
            <div class="reauth-actions">
                <button class="secondary-button" type="button" @click="cancel">
                    {{ t('account.reauth.cancel') }}
                </button>
                <button
                    class="primary-button"
                    type="submit"
                    :disabled="busy || proof === null"
                    data-testid="reauth-submit"
                >
                    {{ t('account.reauth.submit') }}
                </button>
            </div>
        </form>
    </div>
</template>

<style scoped>
.reauth-overlay {
    position: fixed;
    inset: 0;
    background-color: rgba(0, 0, 0, 0.6);
    display: flex;
    justify-content: center;
    align-items: center;
    z-index: 2100;
    padding: 16px;
}

.reauth-panel {
    background: var(--bg-secondary);
    color: var(--text-primary);
    border: 1px solid var(--border-color);
    border-radius: 12px;
    padding: 24px;
    width: 100%;
    max-width: 420px;
    display: flex;
    flex-direction: column;
    gap: 12px;
}

.reauth-switch {
    display: flex;
    gap: 8px;
}

.reauth-switch button[aria-selected='true'] {
    font-weight: 600;
    text-decoration: underline;
}

.reauth-field {
    display: flex;
    flex-direction: column;
    gap: 4px;
}

.reauth-hint {
    margin: 0;
    color: var(--text-secondary);
}

.reauth-error {
    color: var(--danger-color, #d33);
    margin: 0;
}

.reauth-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
}
</style>
