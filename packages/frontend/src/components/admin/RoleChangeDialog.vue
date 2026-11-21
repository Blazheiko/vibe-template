<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue'
import type { Role } from 'shared/access'
import { useModalDialog } from '@/composables/useModalDialog'
import { adminUsersApi } from '@/utils/api'
import { getErrorReason } from '@/utils/response-normalizer'
import {
    ROLE_LABELS,
    roleChangeErrorText,
    roleOptionsFor,
    type RoleTarget,
} from '@/views/admin/role-options'

// feat-241 (docs/plan/roles-permissions-plan.md Р10): change the role of one user. Offers only the
// roles the actor's delegation policy allows; the server checks everything again.

const props = defineProps<{
    open: boolean
    actorRole: Role
    target: (RoleTarget & { name: string }) | null
}>()

const emit = defineEmits<{
    close: []
    changed: [role: Role]
}>()

const panel = ref<HTMLElement | null>(null)
const titleId = useId()
const selected = ref<Role | null>(null)
const saving = ref(false)
const error = ref<string | null>(null)

const options = computed(() =>
    props.target === null ? [] : roleOptionsFor(props.actorRole, props.target),
)

watch(
    () => [props.open, props.target?.id] as const,
    () => {
        selected.value = null
        error.value = null
        saving.value = false
    },
)

function close() {
    if (!saving.value) emit('close')
}

useModalDialog({ panel, isOpen: () => props.open, close })

async function save() {
    const target = props.target
    const role = selected.value
    if (target === null || role === null || saving.value) return
    saving.value = true
    error.value = null
    const res = await adminUsersApi.setRole(target.id, role)
    saving.value = false
    if (res.data?.status === 'success') {
        emit('changed', res.data.user.role)
        return
    }
    error.value = roleChangeErrorText(res.error?.transportCode ?? 0, getErrorReason(res.data))
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
        >
            <h2 :id="titleId" class="role-modal__title">Change role</h2>
            <p class="role-modal__who">
                {{ target.name }} · now <strong>{{ ROLE_LABELS[target.role] }}</strong>
            </p>
            <fieldset class="role-modal__options">
                <legend class="role-modal__legend">New role</legend>
                <label
                    v-for="option in options"
                    :key="option.role"
                    class="role-modal__option"
                    :class="{ 'is-disabled': option.disabledReason !== null }"
                >
                    <input
                        v-model="selected"
                        type="radio"
                        name="role"
                        :value="option.role"
                        :disabled="option.disabledReason !== null || saving"
                    />
                    <span>{{ option.label }}</span>
                    <small v-if="option.disabledReason !== null">
                        {{ option.disabledReason }}
                    </small>
                </label>
            </fieldset>
            <p v-if="error !== null" class="role-modal__error" role="alert">{{ error }}</p>
            <div class="role-modal__actions">
                <button type="button" class="role-modal__btn" :disabled="saving" @click="close">
                    Cancel
                </button>
                <button
                    type="button"
                    class="role-modal__btn role-modal__btn--primary"
                    :disabled="selected === null || saving"
                    @click="save"
                >
                    {{ saving ? 'Saving...' : 'Change role' }}
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
