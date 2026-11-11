<script setup lang="ts">
import { ref, computed, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { Cropper, CircleStencil } from 'vue-advanced-cropper'
import 'vue-advanced-cropper/dist/style.css'
import { useModalDialog } from '@/composables/useModalDialog'

defineOptions({
    name: 'AvatarEditorModal',
})

const props = defineProps<{
    imageFile: Blob
}>()

const emit = defineEmits<{
    (e: 'save', blob: Blob): void
    (e: 'cancel'): void
}>()

const { t } = useI18n()

// The editor is mounted while it is shown: open for its whole life.
const panel = ref<HTMLElement | null>(null)
const titleId = useId()
useModalDialog({
    panel,
    isOpen: () => true,
    close: () => {
        emit('cancel')
    },
})

const cropperRef = ref<InstanceType<typeof Cropper> | null>(null)
const isSaving = ref(false)

// Filter controls
const brightness = ref(100)
const contrast = ref(100)
const saturate = ref(100)

const imageUrl = computed(() => URL.createObjectURL(props.imageFile))

const filterStyle = computed(() => ({
    filter: `brightness(${brightness.value}%) contrast(${contrast.value}%) saturate(${saturate.value}%)`,
}))

function resetFilters(): void {
    brightness.value = 100
    contrast.value = 100
    saturate.value = 100
}

async function handleSave(): Promise<void> {
    if (cropperRef.value === null || isSaving.value) return
    isSaving.value = true

    try {
        const { canvas } = cropperRef.value.getResult()
        if (!canvas) {
            isSaving.value = false
            return
        }

        // Create offscreen canvas for filters + resize
        const size = 512
        const offscreen = document.createElement('canvas')
        offscreen.width = size
        offscreen.height = size
        const ctx = offscreen.getContext('2d')
        if (ctx === null) {
            isSaving.value = false
            return
        }

        // Apply CSS filters
        ctx.filter = `brightness(${brightness.value}%) contrast(${contrast.value}%) saturate(${saturate.value}%)`
        ctx.drawImage(canvas, 0, 0, size, size)

        // Convert to blob
        const blob = await new Promise<Blob | null>((resolve) => {
            offscreen.toBlob(resolve, 'image/webp', 0.85)
        })

        if (blob !== null) {
            emit('save', blob)
        }
    } finally {
        isSaving.value = false
    }
}
</script>

<template>
    <div class="avatar-editor-overlay" @click.self="emit('cancel')">
        <div
            ref="panel"
            class="avatar-editor-modal"
            role="dialog"
            aria-modal="true"
            :aria-labelledby="titleId"
            tabindex="-1"
        >
            <div class="editor-header">
                <h3 :id="titleId">Edit Avatar</h3>
                <button
                    class="close-btn"
                    type="button"
                    :aria-label="t('account.avatar.closeEditor')"
                    data-modal-close
                    @click="emit('cancel')"
                >
                    <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        xmlns="http://www.w3.org/2000/svg"
                        aria-hidden="true"
                    >
                        <path
                            d="M19 6.41L17.59 5L12 10.59L6.41 5L5 6.41L10.59 12L5 17.59L6.41 19L12 13.41L17.59 19L19 17.59L13.41 12L19 6.41Z"
                            fill="currentColor"
                        />
                    </svg>
                </button>
            </div>

            <div class="editor-body">
                <div class="cropper-wrapper" :style="filterStyle">
                    <Cropper
                        ref="cropperRef"
                        :src="imageUrl"
                        :stencil-component="CircleStencil"
                        :stencil-props="{ aspectRatio: 1 }"
                        :canvas="{ maxWidth: 1024, maxHeight: 1024 }"
                        class="cropper"
                    />
                </div>

                <div class="controls">
                    <div class="control-group">
                        <label>
                            <span class="control-label">Brightness</span>
                            <span class="control-value">{{ brightness }}%</span>
                        </label>
                        <input
                            v-model.number="brightness"
                            type="range"
                            min="50"
                            max="150"
                            step="1"
                            class="slider"
                        />
                    </div>

                    <div class="control-group">
                        <label>
                            <span class="control-label">Contrast</span>
                            <span class="control-value">{{ contrast }}%</span>
                        </label>
                        <input
                            v-model.number="contrast"
                            type="range"
                            min="50"
                            max="150"
                            step="1"
                            class="slider"
                        />
                    </div>

                    <div class="control-group">
                        <label>
                            <span class="control-label">Saturation</span>
                            <span class="control-value">{{ saturate }}%</span>
                        </label>
                        <input
                            v-model.number="saturate"
                            type="range"
                            min="0"
                            max="200"
                            step="1"
                            class="slider"
                        />
                    </div>

                    <button class="reset-btn" @click="resetFilters">Reset Filters</button>
                </div>
            </div>

            <div class="editor-footer">
                <button class="cancel-btn" @click="emit('cancel')">Cancel</button>
                <button class="save-btn" :disabled="isSaving" @click="handleSave">
                    {{ isSaving ? 'Saving...' : 'Save' }}
                </button>
            </div>
        </div>
    </div>
</template>

<style scoped>
.avatar-editor-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background-color: rgba(0, 0, 0, 0.6);
    display: flex;
    justify-content: center;
    align-items: center;
    z-index: 2000;
}

.avatar-editor-modal {
    background-color: white;
    border-radius: 16px;
    width: 90%;
    max-width: 520px;
    max-height: 90vh;
    overflow-y: auto;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
}

.avatar-editor-modal:focus {
    outline: none;
}

.dark-theme .avatar-editor-modal {
    background-color: #2a2a2a;
    color: #e0e0e0;
}

.editor-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 16px 20px;
    border-bottom: 1px solid rgba(0, 0, 0, 0.08);
}

.dark-theme .editor-header {
    border-bottom-color: rgba(255, 255, 255, 0.1);
}

.editor-header h3 {
    margin: 0;
    font-size: calc(18px * var(--app-font-scale, 1));
    font-weight: 600;
}

.close-btn {
    background: none;
    border: none;
    padding: 4px;
    cursor: pointer;
    color: inherit;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
}

.close-btn svg {
    width: 22px;
    height: 22px;
}

.close-btn:hover {
    background-color: rgba(0, 0, 0, 0.05);
}

.dark-theme .close-btn:hover {
    background-color: rgba(255, 255, 255, 0.05);
}

.editor-body {
    padding: 16px 20px;
}

.cropper-wrapper {
    width: 100%;
    border-radius: 8px;
    overflow: hidden;
    margin-bottom: 16px;
}

.cropper {
    max-height: 350px;
}

.controls {
    display: flex;
    flex-direction: column;
    gap: 12px;
}

.control-group label {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 4px;
    font-size: calc(13px * var(--app-font-scale, 1));
}

.control-label {
    font-weight: 500;
    color: #333;
}

.dark-theme .control-label {
    color: #ccc;
}

.control-value {
    color: #666;
    font-size: calc(12px * var(--app-font-scale, 1));
    font-variant-numeric: tabular-nums;
}

.dark-theme .control-value {
    color: #aaa;
}

.slider {
    width: 100%;
    height: 4px;
    appearance: none;
    background: #e0e0e0;
    border-radius: 2px;
    outline: none;
    cursor: pointer;
}

.dark-theme .slider {
    background: #555;
}

.slider::-webkit-slider-thumb {
    appearance: none;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: #1a73e8;
    cursor: pointer;
    border: 2px solid white;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.2);
}

.dark-theme .slider::-webkit-slider-thumb {
    background: #64b5f6;
}

.slider::-moz-range-thumb {
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: #1a73e8;
    cursor: pointer;
    border: 2px solid white;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.2);
}

.reset-btn {
    align-self: flex-start;
    padding: 6px 14px;
    background: none;
    border: 1px solid #ccc;
    border-radius: 6px;
    font-size: calc(13px * var(--app-font-scale, 1));
    cursor: pointer;
    color: #666;
    transition: all 0.2s;
}

.dark-theme .reset-btn {
    border-color: #555;
    color: #aaa;
}

.reset-btn:hover {
    border-color: #1a73e8;
    color: #1a73e8;
}

.dark-theme .reset-btn:hover {
    border-color: #64b5f6;
    color: #64b5f6;
}

.editor-footer {
    display: flex;
    justify-content: flex-end;
    gap: 12px;
    padding: 16px 20px;
    border-top: 1px solid rgba(0, 0, 0, 0.08);
}

.dark-theme .editor-footer {
    border-top-color: rgba(255, 255, 255, 0.1);
}

.cancel-btn,
.save-btn {
    padding: 10px 24px;
    border: none;
    border-radius: 8px;
    font-size: calc(14px * var(--app-font-scale, 1));
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s;
}

.cancel-btn {
    background-color: #e9ecef;
    color: #6c757d;
}

.dark-theme .cancel-btn {
    background-color: #444;
    color: #adb5bd;
}

.cancel-btn:hover {
    background-color: #dee2e6;
}

.dark-theme .cancel-btn:hover {
    background-color: #555;
}

.save-btn {
    background-color: #1a73e8;
    color: white;
}

.save-btn:hover {
    background-color: #1565c0;
}

.save-btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
}

@media (max-width: 768px) {
    .avatar-editor-modal {
        width: 95%;
        max-height: 95vh;
    }

    .cropper {
        max-height: 280px;
    }
}
</style>
