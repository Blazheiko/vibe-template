<script setup lang="ts">
import { useI18n } from 'vue-i18n'

// The frame of an auth modal: the dimmed overlay, the panel, the title and the close button. What
// is inside is the slot's; the forms' styles are in assets/auth-forms.css.
defineProps<{
    show: boolean
    title: string
}>()

defineEmits<{ close: [] }>()

const { t } = useI18n()
</script>

<template>
    <div class="modal-overlay" :class="{ show }">
        <div class="modal auth-modal">
            <div class="modal-header">
                <h3>{{ title }}</h3>
                <button
                    class="close-modal"
                    @click="$emit('close')"
                    :aria-label="t('auth.closeModal')"
                >
                    ×
                </button>
            </div>

            <div class="modal-content">
                <slot />
            </div>
        </div>
    </div>
</template>

<style scoped>
.modal-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background-color: rgba(0, 0, 0, 0.5);
    display: flex;
    justify-content: center;
    align-items: center;
    opacity: 0;
    visibility: hidden;
    transition: all 0.3s ease;
    z-index: 1000;
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    padding: 16px;
    padding-top: calc(16px + env(safe-area-inset-top, 0px));
    padding-bottom: calc(16px + env(safe-area-inset-bottom, 0px));
    overflow-y: auto;
}

.dark-theme .modal-overlay {
    background-color: rgba(0, 0, 0, 0.7);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
}

.modal-overlay.show {
    opacity: 1;
    visibility: visible;
}

.modal-overlay.show .modal {
    transform: translateY(0);
    opacity: 1;
}

.modal {
    background-color: white;
    border-radius: 16px;
    width: 100%;
    max-width: 440px;
    max-height: calc(
        100dvh - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px) - 32px
    );
    box-shadow: 0 10px 25px rgba(0, 0, 0, 0.1);
    transform: translateY(-20px);
    transition: all 0.3s ease;
    position: relative;
    display: flex;
    flex-direction: column;
    overflow: hidden;
}

.dark-theme .modal {
    background-color: #1e1e1e;
    box-shadow: 0 10px 25px rgba(0, 0, 0, 0.3);
}

.auth-modal {
    max-width: 440px;
}

.modal-header {
    padding: 16px 20px;
    border-bottom: 1px solid #eee;
    display: flex;
    justify-content: space-between;
    align-items: center;
    position: relative;
}

.dark-theme .modal-header {
    border-bottom-color: #333;
}

.modal-header h3 {
    margin: 0;
    color: var(--primary-color);
    font-size: calc(20px * var(--app-font-scale, 1));
    font-weight: 700;
}

.dark-theme .modal-header h3 {
    color: #e0e0e0;
}

.close-modal {
    background: transparent;
    border: none;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #6c757d;
    transition: all 0.2s ease;
    padding: 0;
    line-height: 1;
    width: 32px;
    height: 32px;
    border-radius: 50%;
    font-size: 22px;
    flex-shrink: 0;
}

.dark-theme .close-modal {
    color: #adb5bd;
}

.close-modal:hover {
    color: var(--primary-color);
    background-color: rgba(0, 0, 0, 0.05);
    transform: rotate(90deg);
}

.dark-theme .close-modal:hover {
    background-color: rgba(255, 255, 255, 0.1);
    color: #fff;
}

.close-modal:active {
    transform: scale(0.9) rotate(90deg);
}

.modal-content {
    padding: 16px 20px 20px;
    flex: 0 1 auto;
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
}

@media (max-width: 768px) {
    .modal {
        max-width: 100%;
        border-radius: 16px;
        min-height: auto;
    }

    .modal-header {
        padding: 14px 16px;
    }

    .modal-header h3 {
        font-size: calc(18px * var(--app-font-scale, 1));
    }

    .modal-content {
        padding: 14px 16px 18px;
    }
}
</style>
