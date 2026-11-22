<script setup lang="ts">
import { ref, useId, watch } from 'vue'
import { useModalDialog } from '@/composables/useModalDialog'
import { withReauth } from '@/composables/useReauth'
import { adminUsersApi } from '@/utils/api'
import { useEventBus } from '@/utils/event-bus'
import { getErrorReason } from '@/utils/response-normalizer'

// feat-247 (docs/plan/passkeys-mfa-plan.md, Р12, Р13): an administrator resets the second factors
// of another account. The change asks the admin to confirm it is them (step-up); the server
// refuses a reset that would leave the account without a way to sign in.

const props = defineProps<{
    open: boolean
    target: { id: string; name: string } | null
}>()

const emit = defineEmits<{ close: []; done: [message: string] }>()

const eventBus = useEventBus()
const panel = ref<HTMLElement | null>(null)
const titleId = useId()
const reason = ref('')
const saving = ref(false)
const error = ref<string | null>(null)

const REASONS: Readonly<Partial<Record<string, string>>> = {
    last_sign_in_method:
        'This account has no other way to sign in. The user first sets a password with "Forgot password", then the factors can be reset.',
    reauth_required: 'Confirm it is you to reset the factors.',
    recovery_session: 'Finish recovering your own account first.',
}

watch(
    () => [props.open, props.target?.id] as const,
    () => {
        reason.value = ''
        error.value = null
        saving.value = false
    },
)

function close() {
    if (!saving.value) emit('close')
}

useModalDialog({ panel, isOpen: () => props.open, close })

async function confirm() {
    const target = props.target
    const why = reason.value.trim()
    if (target === null || saving.value || why.length < 3) return
    saving.value = true
    error.value = null
    const outcome = await withReauth(() => adminUsersApi.resetMfa(target.id, why))
    saving.value = false
    if (outcome.signInAgain) {
        eventBus.emit('sign_in_again', '/admin/users')
        return
    }
    const res = outcome.response
    if (res.data?.status === 'success') {
        emit(
            'done',
            `Two-step sign-in of ${target.name} was reset; their sessions were signed out.`,
        )
        return
    }
    const known = REASONS[getErrorReason(res.data) ?? '']
    error.value =
        known ??
        (res.error?.transportCode === 403
            ? 'You cannot reset this account (your own factors: use a recovery code).'
            : 'Could not reset two-step sign-in. Try again.')
}
</script>

<template>
    <div v-if="open && target !== null" class="role-modal-overlay" @click.self="close">
        <div
            ref="panel"
            class="role-modal"
            role="dialog"
            aria-modal="true"
            :aria-labelledby="titleId"
            tabindex="-1"
            data-testid="mfa-reset-dialog"
        >
            <h2 :id="titleId" class="role-modal__title">Reset two-step sign-in</h2>
            <p class="role-modal__who">
                {{ target.name }} loses every second factor and recovery code and is signed out
                everywhere. They keep their password.
            </p>
            <label class="role-modal__option">
                <span>Reason (goes to the audit log)</span>
                <input
                    v-model="reason"
                    maxlength="200"
                    data-modal-initial-focus
                    data-testid="mfa-reset-reason"
                />
            </label>
            <p v-if="error !== null" class="role-modal__error" role="alert">{{ error }}</p>
            <div class="role-modal__actions">
                <button type="button" class="role-modal__btn" :disabled="saving" @click="close">
                    Cancel
                </button>
                <button
                    type="button"
                    class="role-modal__btn role-modal__btn--primary"
                    :disabled="reason.trim().length < 3 || saving"
                    data-testid="mfa-reset-confirm"
                    @click="confirm"
                >
                    {{ saving ? 'Resetting...' : 'Reset' }}
                </button>
            </div>
        </div>
    </div>
</template>

<style scoped>
.role-modal-overlay {
    position: fixed;
    inset: 0;
    z-index: 1000;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
    background: rgb(0 0 0 / 45%);
}

.role-modal {
    width: min(420px, 100%);
    padding: 20px;
    border-radius: 12px;
    background: var(--bg-primary);
    color: var(--text-primary);
    border: 1px solid var(--border-color);
}

.role-modal__title {
    margin: 0 0 8px;
    font-size: 1.0625rem;
    font-weight: 600;
}

.role-modal__who {
    margin: 0 0 16px;
    color: var(--text-secondary);
}

.role-modal__options {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin: 0;
    padding: 0;
    border: 0;
}

.role-modal__legend {
    margin-bottom: 8px;
    font-size: 0.8125rem;
    color: var(--text-secondary);
}

.role-modal__option {
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
}

.role-modal__option.is-disabled {
    cursor: not-allowed;
    opacity: 0.6;
}

.role-modal__option small {
    color: var(--text-secondary);
}

.role-modal__error {
    margin: 12px 0 0;
    color: var(--error-color, #d33);
}

.role-modal__actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 20px;
}

.role-modal__btn {
    padding: 8px 14px;
    border-radius: 8px;
    border: 1px solid var(--border-color);
    background: transparent;
    color: inherit;
    cursor: pointer;
}

.role-modal__btn--primary {
    background: var(--accent-color);
    border-color: var(--accent-color);
    color: #fff;
}

.role-modal__btn:disabled {
    cursor: not-allowed;
    opacity: 0.6;
}
</style>
