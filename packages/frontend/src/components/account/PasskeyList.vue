<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Passkey } from 'shared/responses'
import { createPasskey, passkeysSupported } from '@/composables/usePasskeys'
import { withReauth } from '@/composables/useReauth'
import { passkeyApi } from '@/utils/api'
import { useEventBus } from '@/utils/event-bus'
import { getErrorReason } from '@/utils/response-normalizer'
import ConfirmDialog from './ConfirmDialog.vue'

// feat-246 (docs/plan/passkeys-mfa-plan.md, Р6, Р12, Р15): the passkeys of the account in the
// sign-in security section. Adding and removing go through the step-up dialog; a first passkey
// brings the recovery codes, which the section shows once.
const props = defineProps<{
    /** A first factor needs a verified contact (Р12); the server says it again anyway. */
    canAdd: boolean
    inRecovery: boolean
    /** The replacement factor was installed in this recovery session (R+). */
    recoveryReplaced: boolean
}>()
const emit = defineEmits<{ changed: []; codes: [codes: string[]] }>()

const { t } = useI18n()
const eventBus = useEventBus()

const supported = ref(false)
const passkeys = ref<Passkey[]>([])
const busy = ref(false)
const message = ref('')
const renaming = ref<{ id: string; name: string } | null>(null)
const removing = ref<Passkey | null>(null)

const REASONS = new Map<string, string>([
    ['recovery_contact_required', 'account.mfa.errorContact'],
    ['passkey_limit', 'account.passkeys.errorLimit'],
    ['passkey_exists', 'account.passkeys.errorExists'],
    ['enrollment_not_found', 'account.mfa.errorSetupExpired'],
    ['enrollment_used', 'account.mfa.errorSetupExpired'],
    ['last_sign_in_method', 'account.passkeys.errorLast'],
    ['recovery_session', 'account.mfa.errorRecoveryOrder'],
    ['invalid_code', 'account.passkeys.errorRejected'],
])
const explain = (data: unknown): string =>
    t(REASONS.get(getErrorReason(data) ?? '') ?? 'account.mfa.errorGeneric')

const signInAgain = (): void => {
    eventBus.emit('sign_in_again', '/account')
}

const date = (iso: string | null): string =>
    iso === null ? t('account.passkeys.never') : new Date(iso).toLocaleDateString()

async function load(): Promise<void> {
    const { data } = await passkeyApi.list()
    if (data?.status === 'success') passkeys.value = data.passkeys
}

async function add(): Promise<void> {
    message.value = ''
    busy.value = true
    try {
        const outcome = await withReauth(() => passkeyApi.registerOptions())
        if (outcome.signInAgain) {
            signInAgain()
            return
        }
        const { data } = outcome.response
        if (data?.status !== 'success') {
            message.value = explain(data)
            return
        }
        const created = await createPasskey(data.options)
        if (!created.ok) {
            message.value =
                created.failure === 'exists'
                    ? t('account.passkeys.errorExists')
                    : created.failure === 'cancelled'
                      ? t('account.passkeys.cancelled')
                      : t('account.passkeys.errorRejected')
            return
        }
        const stored = await passkeyApi.register({
            enrollmentId: data.enrollmentId,
            response: created.value,
        })
        if (stored.data?.status !== 'success') {
            message.value = explain(stored.data)
            return
        }
        message.value = t('account.passkeys.added')
        if (stored.data.recoveryCodes !== null) emit('codes', stored.data.recoveryCodes)
        await load()
        emit('changed')
    } finally {
        busy.value = false
    }
}

async function saveName(): Promise<void> {
    if (renaming.value === null) return
    const { id, name } = renaming.value
    if (name.trim() === '') return
    busy.value = true
    try {
        const { data } = await passkeyApi.rename(id, name.trim())
        if (data?.status !== 'success') {
            message.value = explain(data)
            return
        }
        renaming.value = null
        await load()
    } finally {
        busy.value = false
    }
}

async function remove(): Promise<void> {
    const target = removing.value
    removing.value = null
    if (target === null) return
    message.value = ''
    busy.value = true
    try {
        const outcome = await withReauth(() => passkeyApi.remove(target.id))
        if (outcome.signInAgain) {
            signInAgain()
            return
        }
        const { data } = outcome.response
        message.value = data?.status === 'success' ? t('account.passkeys.removed') : explain(data)
        await load()
        emit('changed')
    } finally {
        busy.value = false
    }
}

onMounted(async () => {
    supported.value = await passkeysSupported()
    await load()
})

defineExpose({ load })
</script>

<template>
    <div class="passkeys" data-testid="passkeys">
        <h3>{{ t('account.passkeys.title') }}</h3>
        <p class="form-message">{{ t('account.passkeys.help') }}</p>
        <ul v-if="passkeys.length > 0" class="passkey-list">
            <li v-for="key in passkeys" :key="key.id" data-testid="passkey-item">
                <template v-if="renaming?.id === key.id">
                    <input
                        v-model="renaming.name"
                        maxlength="64"
                        :aria-label="t('account.passkeys.name')"
                        data-testid="passkey-name-input"
                        @keydown.enter.prevent="saveName"
                    />
                    <button
                        class="secondary-button"
                        type="button"
                        :disabled="busy"
                        data-testid="passkey-save"
                        @click="saveName"
                    >
                        {{ t('account.passkeys.save') }}
                    </button>
                </template>
                <template v-else>
                    <span class="passkey-name" data-testid="passkey-name">{{ key.name }}</span>
                    <span class="passkey-meta">
                        {{
                            t('account.passkeys.meta', {
                                created: date(key.createdAt),
                                used: date(key.lastUsedAt),
                            })
                        }}
                        <template v-if="key.backedUp"
                            >· {{ t('account.passkeys.synced') }}</template
                        >
                    </span>
                    <button
                        v-if="!props.inRecovery"
                        class="secondary-button"
                        type="button"
                        :disabled="busy"
                        data-testid="passkey-rename"
                        @click="renaming = { id: key.id, name: key.name }"
                    >
                        {{ t('account.passkeys.rename') }}
                    </button>
                    <button
                        v-if="!props.inRecovery || props.recoveryReplaced"
                        class="danger-button"
                        type="button"
                        :disabled="busy"
                        data-testid="passkey-remove"
                        @click="removing = key"
                    >
                        {{ t('account.passkeys.remove') }}
                    </button>
                </template>
            </li>
        </ul>
        <p v-else class="form-message" data-testid="passkeys-empty">
            {{ t('account.passkeys.empty') }}
        </p>
        <button
            v-if="supported"
            class="secondary-button"
            type="button"
            :disabled="busy || (!props.canAdd && passkeys.length === 0)"
            data-testid="passkey-add"
            @click="add"
        >
            {{ t('account.passkeys.add') }}
        </button>
        <p v-else class="form-message" data-testid="passkeys-unsupported">
            {{ t('account.passkeys.unsupported') }}
        </p>
        <p v-if="message" class="form-message" role="status" data-testid="passkey-message">
            {{ message }}
        </p>

        <ConfirmDialog
            v-if="removing !== null"
            :title="t('account.passkeys.removeTitle')"
            :text="t('account.passkeys.removeText', { name: removing.name })"
            :confirm-label="t('account.passkeys.remove')"
            :cancel-label="t('account.reauth.cancel')"
            @confirm="remove"
            @cancel="removing = null"
        />
    </div>
</template>

<style scoped>
.passkeys {
    margin: 16px 0;
}

.passkey-list {
    list-style: none;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.passkey-list li {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
}

.passkey-name {
    font-weight: 600;
}

.passkey-meta {
    color: var(--text-secondary);
    font-size: 0.9em;
}
</style>
