<script setup lang="ts">
import { ref, useId } from 'vue'
import { useModalDialog } from '@/composables/useModalDialog'

// A confirmation of the app's own (feat-233): window.confirm() blocks the page and cannot be
// styled or tested. Mounted while it is shown.
defineProps<{
    title: string
    text: string
    confirmLabel: string
    cancelLabel: string
}>()
const emit = defineEmits<{ confirm: []; cancel: [] }>()

const panel = ref<HTMLElement | null>(null)
const titleId = useId()
const textId = useId()
useModalDialog({
    panel,
    isOpen: () => true,
    close: () => {
        emit('cancel')
    },
})
</script>

<template>
    <div class="confirm-overlay" @click.self="emit('cancel')">
        <div
            ref="panel"
            class="confirm-panel"
            role="alertdialog"
            aria-modal="true"
            :aria-labelledby="titleId"
            :aria-describedby="textId"
            tabindex="-1"
            data-testid="confirm-dialog"
        >
            <h3 :id="titleId">{{ title }}</h3>
            <p :id="textId">{{ text }}</p>
            <div class="confirm-actions">
                <button
                    class="secondary-button"
                    type="button"
                    data-modal-initial-focus
                    data-testid="confirm-cancel"
                    @click="emit('cancel')"
                >
                    {{ cancelLabel }}
                </button>
                <button
                    class="danger-button"
                    type="button"
                    data-testid="confirm-accept"
                    @click="emit('confirm')"
                >
                    {{ confirmLabel }}
                </button>
            </div>
        </div>
    </div>
</template>

<style scoped>
.confirm-overlay {
    position: fixed;
    inset: 0;
    background-color: rgba(0, 0, 0, 0.6);
    display: flex;
    justify-content: center;
    align-items: center;
    z-index: 2000;
    padding: 16px;
}

.confirm-panel {
    background: var(--bg-secondary);
    color: var(--text-primary);
    border: 1px solid var(--border-color);
    border-radius: 12px;
    width: 100%;
    max-width: 420px;
    padding: 20px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
}

.confirm-panel:focus {
    outline: none;
}

.confirm-panel h3 {
    margin: 0 0 8px;
}

.confirm-panel p {
    margin: 0 0 16px;
    color: var(--text-secondary);
}

.confirm-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    flex-wrap: wrap;
}

.secondary-button,
.danger-button {
    min-height: 36px;
    border: 1px solid var(--border-color);
    border-radius: 6px;
    padding: 0 12px;
    cursor: pointer;
}

.secondary-button {
    background: var(--bg-primary);
    color: var(--text-primary);
}

.danger-button {
    background: var(--error-color, #b91c1c);
    border-color: var(--error-color, #b91c1c);
    color: #fff;
}
</style>
